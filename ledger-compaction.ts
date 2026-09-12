import { estimateMessagesTokens } from "./context-budget.js";
import type { LlmMessage } from "./llm-client.js";
import { ConversationLedger } from "./conversation-ledger.js";

// Deciding where to cut a ledger, and how to ask for the summary that replaces
// the front.
//
// Compaction is the one operation that breaks what the ledger promises: the
// prefix stops extending and every cached token in front of the cut is paid for
// again. That cost is real and unavoidable once a transcript outgrows the
// window, so the job here is to make the cut rare, correct, and explicit —
// never to make it look harmless.
//
// "Correct" has a hard edge. A cut that lands between an assistant's tool_use
// and the tool_result answering it leaves the kept half holding an orphan, and
// the API rejects the next request outright. So the planner only ever cuts on a
// settled boundary, and would rather summarize more than land on a bad one.
//
// 摘要这一次调用本身，照 kagami 的做法复用焦点循环的前缀：同一份 system、同一套工具、整本账本
// 原样照发，只在尾部追加一条整理指令（见 buildLedgerCompactionMessages）。以前是另起一个请求，
// 把前半段序列化成一大段纯文本，十万 token 每次都按全价重读；现在这些 token 上一轮刚被焦点
// 循环写进缓存，读回来只要一成的价。
//
// 摘要要能一次次叠下去。上一次压缩留下的摘要包在 <conversation_summary> 里，下一次整理时
// 指令要求把它当基线保守合并，而不是和别的消息一起重新概括——否则每压缩一次，最早的记忆就
// 被冲淡一层，几次之后就没了。

export type LedgerCompactionPlan = {
  /** The front, to be replaced by one summary turn. */
  summarize: LlmMessage[];
  /** The tail, kept verbatim. Always starts on a round's opening injection. */
  keep: LlmMessage[];
};

export type LedgerCompactionOptions = {
  /** Compact only once the transcript is worth this many estimated tokens. */
  thresholdTokens: number;
  /** Share of turns kept verbatim, as a fraction of the transcript. */
  keepRatio: number;
};

export const DEFAULT_LEDGER_COMPACTION_OPTIONS: LedgerCompactionOptions = {
  thresholdTokens: 120_000,
  keepRatio: 0.25,
};

// 焦点循环的工具必须照样带着——工具定义在前缀里，少一个前缀就对不上——但整理摘要时不该真的去开
// 会话、发消息。模型真去调，就收到这一句。格式和 qq-tools 的失败结果一致。
export const LEDGER_COMPACTION_TOOL_REFUSAL = JSON.stringify({
  ok: false,
  error: "compaction_in_progress",
  note: "现在是在整理累计摘要，工具都不能用。直接输出摘要正文。",
});

// 正常一轮就写完；留两轮余量，给模型先调一次工具、被拒之后再写的情况。
export const LEDGER_COMPACTION_MAX_ROUNDS = 3;

const LEDGER_SUMMARY_OPEN = "<conversation_summary>";
const LEDGER_SUMMARY_CLOSE = "</conversation_summary>";

function opensToolCalls(message: LlmMessage | undefined): boolean {
  return (message?.blocks ?? []).some((block) => block.type === "tool_use");
}

// 焦点循环的每一轮都从一条注入开始（「[通知] …」或「[焦点已切到 …]」），账本又不允许在工具调用
// 没收到结果时追加用户文本，所以「一条带文字、不带工具结果的 user 消息」就是一轮的起点。切点对齐
// 到这里有两个好处：保留下来的尾巴总从完整的一轮开始，不会切断工具调用；整理指令也能引用这条注入
// 的原文，准确告诉模型「摘到这里为止」——一条 assistant 回合或工具结果没法这样指认。
function startsRound(message: LlmMessage | undefined): boolean {
  return message?.role === "user"
    && message.content.trim().length > 0
    && !(message.blocks ?? []).some((block) => block.type === "tool_result");
}

export function planLedgerCompaction(
  messages: readonly LlmMessage[],
  options: LedgerCompactionOptions = DEFAULT_LEDGER_COMPACTION_OPTIONS,
): LedgerCompactionPlan | null {
  if (messages.length < 2) {
    return null;
  }
  if (estimateMessagesTokens(messages) <= options.thresholdTokens) {
    return null;
  }

  const ratio = Math.min(0.9, Math.max(0.05, options.keepRatio));
  const keepCount = Math.max(1, Math.ceil(messages.length * ratio));
  let cutIndex = Math.max(1, messages.length - keepCount);
  while (cutIndex < messages.length && !(startsRound(messages[cutIndex]) && !opensToolCalls(messages[cutIndex - 1]))) {
    cutIndex += 1;
  }

  // Walking to a round start can reach the end when the tail is one long round.
  // Summarizing everything would leave the model with a summary and no live turn
  // to answer, so decline instead — a transcript that cannot be cut safely is
  // one to leave alone and report.
  if (cutIndex >= messages.length) {
    return null;
  }

  return {
    summarize: messages.slice(0, cutIndex),
    keep: messages.slice(cutIndex),
  };
}

function clipLine(line: string, maxChars = 120): string {
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

// 引用第一条保留消息的头尾两行。注入的第一行（「[通知] 群X 有 N 条新消息」）会反复出现，最后一行
// 的本轮元数据带着 current_time，两行合起来足够在整本账本里认出唯一的那一条。
function quoteRoundStart(message: LlmMessage): string[] {
  const lines = message.content.split("\n").map((line) => line.trim()).filter(Boolean);
  const first = `「${clipLine(lines[0] ?? "")}」`;
  if (lines.length < 2) return [first];
  return [first, "……", `「${clipLine(lines[lines.length - 1])}」`];
}

// firstKept 为 null 表示整本都要摘要：账本过期（隔了很久没有新的一轮），没有要原样保留的尾巴。
export function buildLedgerCompactionInstruction(firstKept: LlmMessage | null): string {
  const range = firstKept
    ? [
      "现在不是新的一轮消息，也不用决定回不回谁。上下文前面这一段马上会被压缩掉，只留下一份摘要，之后你要靠它把事情自然接下去。请为自己整理这份累计摘要。",
      "",
      "摘要的范围：从上下文开头，到下面这条消息之前为止。这条消息和它之后的内容会原样留在上下文里，不要写进摘要。",
      ...quoteRoundStart(firstKept),
    ]
    : [
      "现在不是新的一轮消息，也不用决定回不回谁。上面这整段对话已经隔了很久没有继续，马上会被压缩成一份摘要，之后的新消息接在摘要后面。请为自己整理这份累计摘要。",
      "",
      "摘要的范围：上面的全部内容。里面说的「刚刚」「现在」「等会儿」都是很久以前的事，按已经过去的事来写，不要写成还在进行的对话；当时答应过、还没兑现的事照样记下，注明是当时说的。",
    ];
  return [
    "<system_reminder>",
    ...range,
    "",
    "如果范围开头有 <conversation_summary>，那是上一次压缩留下的累计记忆。把它当作基线，和之后的新内容保守合并：旧摘要里仍然成立的内容必须保留；只有明确失效、被新事实覆盖、或者已经结束且不再影响后面的，才可以删掉或改写，删改时留下仍然有意义的结果和影响。",
    "",
    "优先保留压缩后最容易丢、又最影响后面接不接得上的东西：",
    "- 跨很多轮都还成立的背景：群规、群里的关系、谁是谁、长期的判断。",
    "- 还没聊完的话题和线索，以及推进到了哪一步。",
    "- 你说过的、后面还有影响的话：答应过谁什么、还没兑现的事。",
    "- 你自己的感受和倾向：想接什么、不想接什么、哪些话题让你烦或者尴尬。",
    "- 做过的事和结果：发过什么、为什么发、效果如何，包括没奏效的尝试。",
    "",
    "不用记当前打开的是哪个会话：每一轮的消息里都会重新写明「当前打开」。寒暄、复读、已经失效的瞬时信息也不用记。",
    "",
    "用下面这些二级标题组织，顺序固定，某一节没有内容就写「无」：",
    "## 持续背景",
    "## 群和人",
    "## 还在延续的线索",
    "## 说过的话和承诺",
    "## 我的感受与倾向",
    "## 做过的事和结果",
    "",
    "每节用短条目，一条只写一组紧密相关的信息，写清是哪个群（群号）、哪个人（昵称和 QQ 号）、发生了什么、落点是什么，方便下一次准确合并。不要按消息逐条复述成流水账；不要编造上下文里没有的事，不确定的写明不确定。",
    "长度随有效信息量变化，通常 1500 到 5000 字；信息多可以更长，信息少就短，不要为了凑字数重复。",
    "",
    "不要调用任何工具。直接输出摘要正文，从第一个二级标题开始，不要加任何前后缀，也不要自己包 <conversation_summary> 标签。",
    "</system_reminder>",
  ].join("\n");
}

// 摘要请求 = 账本原样 + 尾部一条整理指令。前面一个字节都不能动：这次调用要读回的，正是焦点循环
// 上一轮刚写进缓存的前缀，重新序列化、删一条、改一个字，都会让它从零重读。
export function buildLedgerCompactionMessages(
  ledger: readonly LlmMessage[],
  plan: LedgerCompactionPlan,
): LlmMessage[] {
  const firstKept = plan.keep[0];
  if (!firstKept) {
    throw new Error("buildLedgerCompactionMessages: the plan keeps nothing to anchor the summary on.");
  }
  return [...ledger, { role: "user", content: buildLedgerCompactionInstruction(firstKept) }];
}

// 过期账本的整本摘要请求。旧账本原样发出去，只按 restore 的规矩先理顺：结尾没收到结果的工具调用
// 丢掉，否则末尾那个 tool_use 配不上结果，请求直接 400。
export function buildStaleLedgerSummaryMessages(transcript: readonly LlmMessage[]): LlmMessage[] {
  const settled = new ConversationLedger();
  settled.restore(transcript);
  const messages = settled.snapshot();
  if (messages.length === 0) {
    throw new Error("buildStaleLedgerSummaryMessages: nothing left to summarize after settling the transcript.");
  }
  return [...messages, { role: "user", content: buildLedgerCompactionInstruction(null) }];
}

export function renderLedgerSummaryTurn(summary: string): string {
  return `${LEDGER_SUMMARY_OPEN}\n${summary.trim()}\n${LEDGER_SUMMARY_CLOSE}`;
}

// 模型偶尔会自己包一层标签，或者在正文前面加一句「以下是摘要」。都剥掉，账本里只留一层标签。
export function extractLedgerSummary(reply: string): string {
  const tagged = reply.match(/<conversation_summary>\s*([\s\S]*?)\s*<\/conversation_summary>/u);
  const body = (tagged ? tagged[1] : reply).trim();
  const firstHeading = body.search(/^## /mu);
  return firstHeading > 0 ? body.slice(firstHeading).trim() : body;
}
