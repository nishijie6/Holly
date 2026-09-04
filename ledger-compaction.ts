import { estimateMessagesTokens } from "./context-budget.js";
import type { LlmMessage } from "./llm-client.js";

// Deciding where to cut a ledger, and nothing else.
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

export type LedgerCompactionPlan = {
  /** The front, to be replaced by one summary turn. */
  summarize: LlmMessage[];
  /** The tail, kept verbatim. */
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

function opensToolCalls(message: LlmMessage | undefined): boolean {
  return (message?.blocks ?? []).some((block) => block.type === "tool_use");
}

function answersToolCalls(message: LlmMessage | undefined): boolean {
  return (message?.blocks ?? []).some((block) => block.type === "tool_result");
}

/**
 * Move a cut forward until the kept half starts on a settled turn.
 *
 * Two ways a naive cut breaks the request: the kept half opens with tool_results
 * whose tool_use was summarized away, or the summarized half ends with a
 * tool_use whose results were kept. Both are the same split pair seen from
 * either side, and both are 400s rather than degraded answers.
 */
function settleCutIndex(messages: readonly LlmMessage[], cutIndex: number): number {
  let index = Math.max(0, Math.min(cutIndex, messages.length));
  while (index < messages.length && (answersToolCalls(messages[index]) || opensToolCalls(messages[index - 1]))) {
    index += 1;
  }
  return index;
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
  const cutIndex = settleCutIndex(messages, messages.length - keepCount);

  // Settling can walk the cut to the end when the tail is one long unbroken tool
  // exchange. Summarizing everything would leave the model with a summary and no
  // live turn to answer, so decline instead — a transcript that cannot be cut
  // safely is one to leave alone and report.
  if (cutIndex <= 0 || cutIndex >= messages.length) {
    return null;
  }

  return {
    summarize: messages.slice(0, cutIndex),
    keep: messages.slice(cutIndex),
  };
}

/** What the model is asked to preserve when the front of a transcript is dropped. */
export function buildLedgerSummaryPrompt(messages: readonly LlmMessage[]): string {
  const transcript = messages
    .map((message) => {
      const blocks = (message.blocks ?? []).map((block) => (
        block.type === "tool_use"
          ? `[调用 ${block.name} ${JSON.stringify(block.input)}]`
          : `[工具结果] ${block.content}`
      ));
      return [`<${message.role}>`, message.content, ...blocks].filter(Boolean).join("\n");
    })
    .join("\n\n");

  return [
    "以下是你更早的对话记录，即将被这段摘要替代。",
    "写一段第一人称的摘要，保留：正在进行的话题、你对谁做过什么承诺、还没兑现的事、以及你当前打开的是哪个会话。",
    "不要复述寒暄，不要编造没发生的事。写成连续的叙述，不要列表。",
    "",
    transcript,
  ].join("\n");
}
