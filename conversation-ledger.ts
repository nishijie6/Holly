import type { LlmMessage, LlmStructuralBlock, LlmToolResultBlock, LlmToolUseBlock } from "./llm-client.js";

// The agent's context as one append-only list, replacing "rebuild the request
// from per-group history on every call".
//
// Why the shape matters: a prompt-cache entry survives only while the prefix in
// front of it is byte-identical. Rebuilding cannot promise that — cache-prefix.ts
// exists precisely because nothing structurally prevented a volatile value from
// drifting in. Growing one list can promise it, because the only legal operation
// is to add to the end. That is the whole idea, borrowed from kagami's
// LinearMessageLedgerAgentContext, whose interface is likewise all `append*`.
//
// So this class exposes no way to edit or remove a turn. Compaction, when it
// arrives, must be an explicit new operation that says out loud that it breaks
// the prefix — not an innocuous-looking splice.

export type LedgerAppendResult = {
  index: number;
  messageCount: number;
};

export class ConversationLedger {
  private readonly messages: LlmMessage[] = [];
  // tool_use ids emitted by the newest assistant turn that has not been answered.
  private pendingToolUseIds: string[] = [];
  // Called for every turn that lands, so durability cannot drift from the
  // in-memory transcript: there is one place a message is added, and it is the
  // same place the sink is told. Not called by restore() — those turns are
  // already on disk, and re-writing them would double the log every boot.
  private readonly onAppend: ((message: LlmMessage) => void) | null;

  constructor(options: { onAppend?: (message: LlmMessage) => void } = {}) {
    this.onAppend = options.onAppend ?? null;
  }

  /** A read-only view. Callers build requests from this; they must not mutate it. */
  public snapshot(): readonly LlmMessage[] {
    return this.messages;
  }

  public get size(): number {
    return this.messages.length;
  }

  /** Every tool_use from the last assistant turn still waiting for a result. */
  public get pendingToolUses(): readonly string[] {
    return this.pendingToolUseIds;
  }

  public appendUserText(content: string): LedgerAppendResult {
    const text = content.trim();
    if (!text) {
      throw new Error("ConversationLedger: refusing to append an empty user turn.");
    }
    if (this.pendingToolUseIds.length > 0) {
      // Slipping prose between a tool_use and its result orphans the id: the API
      // rejects the next request, and the failure surfaces far from this call.
      throw new Error(
        `ConversationLedger: ${this.pendingToolUseIds.length} tool call(s) still unanswered; append their results first.`,
      );
    }
    return this.push({ role: "user", content: text });
  }

  public appendAssistantTurn(content: string, toolUses: readonly LlmToolUseBlock[] = []): LedgerAppendResult {
    const text = content.trim();
    if (!text && toolUses.length === 0) {
      throw new Error("ConversationLedger: refusing to append an empty assistant turn.");
    }
    if (this.pendingToolUseIds.length > 0) {
      throw new Error("ConversationLedger: previous tool calls are still unanswered.");
    }
    this.pendingToolUseIds = toolUses.map((use) => use.id);
    return this.push({
      role: "assistant",
      content: text,
      ...(toolUses.length > 0 ? { blocks: [...toolUses] } : {}),
    });
  }

  /**
   * Every result for the open assistant turn, in one turn — which is both what
   * the API wants and what stops the model from giving up on parallel calls.
   */
  public appendToolResults(results: readonly LlmToolResultBlock[]): LedgerAppendResult {
    if (this.pendingToolUseIds.length === 0) {
      throw new Error("ConversationLedger: no tool calls are awaiting results.");
    }
    const got = new Set(results.map((result) => result.toolUseId));
    const missing = this.pendingToolUseIds.filter((id) => !got.has(id));
    if (missing.length > 0) {
      // Caught here as a local error rather than as a 400 on the next request.
      throw new Error(`ConversationLedger: missing tool_result for ${missing.join(", ")}.`);
    }
    const unexpected = [...got].filter((id) => !this.pendingToolUseIds.includes(id));
    if (unexpected.length > 0) {
      throw new Error(`ConversationLedger: tool_result for unknown id ${unexpected.join(", ")}.`);
    }
    this.pendingToolUseIds = [];
    return this.push({ role: "user", content: "", blocks: [...results] as LlmStructuralBlock[] });
  }

  /**
   * Rebuild from persisted turns at boot. Only legal while empty: the point of
   * the ledger is that nothing rewrites it once it is running, and a restore
   * that could overwrite live history would be exactly that.
   */
  public restore(messages: readonly LlmMessage[]): void {
    if (this.messages.length > 0) {
      throw new Error("ConversationLedger: restore() is only valid on an empty ledger.");
    }
    for (const message of messages) {
      this.messages.push(message);
    }
    // A transcript that ends mid tool call would make the first live append
    // throw. Anything unanswered at the boundary is dropped with the turn that
    // opened it, so the restored ledger always starts settled.
    while (this.messages.length > 0) {
      const last = this.messages[this.messages.length - 1];
      const opensToolCalls = (last.blocks ?? []).some((block) => block.type === "tool_use");
      if (!opensToolCalls) break;
      this.messages.pop();
    }
  }

  /**
   * Replace the front of the transcript with one summary turn.
   *
   * This is the exception the class comment promised, and it is deliberately
   * ugly to call: it BREAKS THE PROMPT-CACHE PREFIX. Everything in front of the
   * cut stops being a cache read and is paid for again at full price on the next
   * request, and the drift detector will report a rebuilt prefix — correctly.
   * Callers must expect that (expectRebuild) rather than treat it as a defect.
   *
   * `keep` must come from planLedgerCompaction, which guarantees it starts on a
   * settled turn; a tail beginning with orphaned tool_results is a 400.
   */
  public replaceFrontWithSummary(summary: string, keep: readonly LlmMessage[]): void {
    const text = summary.trim();
    if (!text) {
      throw new Error("ConversationLedger: refusing to compact into an empty summary.");
    }
    if (this.pendingToolUseIds.length > 0) {
      throw new Error("ConversationLedger: cannot compact while tool calls are unanswered.");
    }
    if (keep.some((message) => (message.blocks ?? []).some((block) => block.type === "tool_result"))
      && (keep[0]?.blocks ?? []).some((block) => block.type === "tool_result")) {
      throw new Error("ConversationLedger: the kept tail starts with an orphaned tool_result.");
    }
    this.messages.length = 0;
    this.messages.push({ role: "user", content: text });
    for (const message of keep) {
      this.messages.push(message);
    }
  }

  private push(message: LlmMessage): LedgerAppendResult {
    this.messages.push(message);
    this.onAppend?.(message);
    return { index: this.messages.length - 1, messageCount: this.messages.length };
  }
}
