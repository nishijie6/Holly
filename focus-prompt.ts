import { loadPromptText } from "./prompt-text.js";
import type { FocusDecision } from "./focus-policy.js";

// focus 管线自己的协议,以及每一轮往 ledger 里追加的那条 user turn 的渲染。
//
// 为什么不能沿用 decision-prompt.ts:那份 MODEL_DECISION_PROMPT 是为「一次调用出
// 一个 JSON 决定」的老管线写的,通篇在讲 should_reply / final_answer / need_search
// 该怎么填。focus 管线是 tool loop——发消息的唯一途径是调 send_message,模型直接
// 写出来的文字在 runClaudeToolLoop 里只会变成 lastText 进 monitor,一个字都到不了
// 群里。把决策协议交给 tool loop,结果不是「回复质量差一点」,而是 Holly 彻底沉默。
// 两条管线的协议因此必须分开,就像 focus-mode-config.ts 里说的,它们半路上并不兼容。
//
// 这个文件也顺带承接了「进上下文的散文收口在一处」:focus 管线每轮注入的文本(焦点
// 切换说明、后台通知、本轮元数据)全在这里渲染,main.ts 只负责取数据。老管线的
// formatUnreadMessagesForModel 不适合搬过来——它假设「消息内容已经在缓存前缀里的
// 时间线上」,而后台通知路径根本不推时间线,照搬的结果是模型收到一段只有 current_time
// 和 group_id 的扫描元数据,看不到任何消息内容,自然也判断不出该不该打开会话。

// 焦点为什么会落到这个会话上。focus-policy 的 reason 是给 monitor 看的英文枚举,
// 但它确实会随注入文本进模型视野,所以在这里翻成模型能读懂的一句话,而不是让
// "at-mention" 这种字样直接出现在中文上下文里。
const FOCUS_REASON_TEXT: Record<FocusDecision["reason"], string> = {
  "at-mention": "有人在群里 @ 了你",
  ambient: "只是群里有动静,没人直接找你",
};

// 正文在 prompts/focus-loop.md。这是 focus 管线的协议本身,改它等于改她在群里怎么行事。
export const FOCUS_LOOP_PROMPT = loadPromptText("focus-loop");

export function buildFocusSystemPrompt(basePrompt: string): string {
  return `${basePrompt}\n\n${FOCUS_LOOP_PROMPT}`;
}

// 本轮进 ledger 的那条 user turn 需要的全部素材。
//
// 注意 recent 和 batch 的分工:前台路径推整段 recent(新消息本来就在里面,事件到达
// 时就追加进 conversationHistoryByGroup 了),所以不必再单独列一遍 batch;后台路径
// 不推 recent,batch 摘要是模型唯一能看到的内容,省掉它模型就只能靠会话名瞎猜。
export type FocusBatchMessage = {
  // 已经格式化好的发送人标签,形如 "[张三(123456)]";拿不到发送人时为 null。
  senderLabel: string | null;
  text: string;
};

export type FocusInjectionInput = {
  conversationLabel: string;
  // 注入这一刻当前打开的会话,也就是 send_message 的目标;还没打开过任何会话时为 null。
  // 前台路径里它就等于 conversationLabel(系统刚替模型切过去),后台通知里常常不等。
  openConversationLabel: string | null;
  reason: FocusDecision["reason"];
  currentTime: string;
  // 会话最近若干条消息,已按时间线格式渲染。仅前台路径使用。
  recent: readonly string[];
  batch: readonly FocusBatchMessage[];
  // 本批里通过身份校验的管理员 QQ 号。空数组表示这不是管理员消息。
  adminUserIds: readonly string[];
  // 管理员改进代码命令的受理结果,二者至多有一个。
  codeJobId?: string | null;
  codeJobNote?: string | null;
};

// 后台通知里给出多少条消息、每条多长。给通知的定位是「值不值得点开」的线索,不是
// 会话正文——真要看全文,模型有 open_conversation。调大这两个数会让 ledger 里每条
// 通知都变长,而通知是永久追加的,长期成本比看起来高。
const NOTIFICATION_MAX_MESSAGES = 4;
const NOTIFICATION_MAX_CHARS_PER_MESSAGE = 60;

function renderBatchLine(message: FocusBatchMessage, maxChars: number): string | null {
  const text = message.text.trim().replace(/\s+/gu, " ");
  if (!text) {
    return null;
  }
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  return message.senderLabel ? `${message.senderLabel} ${clipped}` : clipped;
}

// 每轮都变的那几个值(当前时间、会话、管理员名单)。它们跟着注入文本一起追加到
// ledger 尾部,所以不影响缓存前缀;但也因此会永久留在 ledger 里,所以只放模型真正
// 要用的几项,老管线那段 "Scheduled reply scan for this conversation:" 的完整
// 元数据块不往这里搬。
//
// 会话必须拆成「消息来自」和「当前打开」两项写。这里原本只有一个 conversation: 群X,
// 后台通知里它指的是消息来自哪,模型却读成了「我现在在 X」,没打开就 send_message,
// 话进了焦点实际停着的另一个群。
// 前台路径里两项相同也照写:同一个字段在两种注入里意思不同,正是那次误读的来源。
function renderRoundMetadata(input: FocusInjectionInput): string[] {
  const lines = [
    `current_time: ${input.currentTime}`,
    `消息来自: ${input.conversationLabel}`,
    `当前打开: ${input.openConversationLabel ?? "无"}`,
  ];
  if (input.adminUserIds.length > 0) {
    lines.push(`管理员消息,发送人 user_id: ${Array.from(new Set(input.adminUserIds)).join(", ")}`);
    if (input.codeJobId) {
      lines.push(
        `改进代码的命令已受理,job_id=${input.codeJobId}。告诉他已经进执行队列、结果稍后汇报,不要说已经跑完或已经生效。`,
      );
    } else if (input.codeJobNote) {
      lines.push(`改进代码的命令没能启动,把这个原因原样告诉他:${input.codeJobNote}`);
    }
  }
  return [`[本轮 ${lines.join(" | ")}]`];
}

export function buildFocusForegroundInjection(input: FocusInjectionInput): string {
  return [
    `[焦点已切到 ${input.conversationLabel}——${FOCUS_REASON_TEXT[input.reason]}]`,
    ...input.recent,
    ...renderRoundMetadata(input),
  ].filter(Boolean).join("\n");
}

export function buildFocusNotificationInjection(input: FocusInjectionInput): string {
  const lines = input.batch
    .slice(-NOTIFICATION_MAX_MESSAGES)
    .map((message) => renderBatchLine(message, NOTIFICATION_MAX_CHARS_PER_MESSAGE))
    .filter((line): line is string => line !== null);
  const omitted = Math.max(0, input.batch.length - NOTIFICATION_MAX_MESSAGES);

  return [
    `[通知] ${input.conversationLabel} 有 ${input.batch.length} 条新消息,焦点没动:`,
    ...lines.map((line) => `  ${line}`),
    ...(omitted > 0 ? [`  (前面还有 ${omitted} 条没列出来,要看全文就 open_conversation)`] : []),
    ...renderRoundMetadata(input),
  ].filter(Boolean).join("\n");
}
