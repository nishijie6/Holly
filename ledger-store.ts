import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LlmMessage, LlmStructuralBlock } from "./llm-client.js";

// Durable backing for ConversationLedger, as an append-only JSONL log — the same
// shape as thought-history.ts, and for the same reason: the thing being stored is
// a sequence that only ever grows, so the file format should be too. One line per
// turn means a crash costs at most the turn being written, never the transcript.
//
// Two bounds decide whether a restored transcript is used at all, and when either
// bites the ledger starts empty rather than partially truncated. That is
// deliberate: dropping the front of a transcript is compaction, it breaks the
// prompt-cache prefix, and doing it silently inside a restore is exactly the kind
// of invisible rewrite the ledger exists to prevent. A clean start is honest and
// its cost is one cold prefix; a silent truncation is neither.

export type LedgerRestoreOutcome = {
  messages: LlmMessage[];
  // Why the transcript was not restored in full, for the monitor. null = restored.
  rejected: null | "stale" | "too-large" | "unreadable";
  /** Lines that were on disk, whether or not they were restored. */
  recordCount: number;
};

export type LedgerStoreOptions = {
  /** A transcript older than this is a different conversation, not this one. */
  maxAgeMs: number;
  /**
   * A last-resort guard, not the routine size limit.
   *
   * Size is governed by ledger-compaction, which measures tokens. This one
   * counts turns, so the two disagree: a transcript of many short turns can pass
   * compaction's budget comfortably and still trip a turn count. Set well above
   * anything compaction leaves behind, so that tripping it means something is
   * actually wrong (compaction wedged, a runaway loop) rather than that the
   * conversation simply got long — because tripping it throws the transcript
   * away whole.
   */
  maxMessages: number;
};

export const DEFAULT_LEDGER_STORE_OPTIONS: LedgerStoreOptions = {
  maxAgeMs: 12 * 60 * 60 * 1000,
  maxMessages: 2_000,
};

type LedgerRecord = { at: string; message: LlmMessage };

function coerceStructuralBlock(value: unknown): LlmStructuralBlock | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.type === "tool_use") {
    // The id is the only thing pairing this with its result. A block that lost
    // it cannot be replayed, and guessing one would 400 the next request.
    if (typeof v.id !== "string" || typeof v.name !== "string") return null;
    return {
      type: "tool_use",
      id: v.id,
      name: v.name,
      input: (v.input && typeof v.input === "object" ? v.input : {}) as Record<string, unknown>,
    };
  }
  if (v.type === "tool_result") {
    if (typeof v.toolUseId !== "string") return null;
    return {
      type: "tool_result",
      toolUseId: v.toolUseId,
      content: typeof v.content === "string" ? v.content : "",
      ...(v.isError === true ? { isError: true } : {}),
    };
  }
  return null;
}

function coerceRecord(value: unknown): LedgerRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const message = v.message;
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") return null;

  const blocks = Array.isArray(m.blocks)
    ? m.blocks.map(coerceStructuralBlock).filter((b): b is LlmStructuralBlock => b !== null)
    : [];
  // A tool turn that lost blocks in transit is not a turn any more — replaying
  // its prose alone would silently change what the model was answering.
  if (Array.isArray(m.blocks) && blocks.length !== m.blocks.length) return null;

  return {
    at: typeof v.at === "string" ? v.at : "",
    message: {
      role: m.role,
      content: typeof m.content === "string" ? m.content : "",
      ...(blocks.length > 0 ? { blocks } : {}),
    },
  };
}

export class LedgerStore {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly options: LedgerStoreOptions,
  ) {}

  static async load(
    filePath: string,
    options: LedgerStoreOptions = DEFAULT_LEDGER_STORE_OPTIONS,
    now = Date.now(),
  ): Promise<{ store: LedgerStore; outcome: LedgerRestoreOutcome }> {
    const store = new LedgerStore(filePath, options);

    let raw = "";
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      return { store, outcome: { messages: [], rejected: null, recordCount: 0 } };
    }

    const records: LedgerRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = coerceRecord(JSON.parse(trimmed));
        if (record) records.push(record);
      } catch {
        // One torn line (a crash mid-write) must not cost the whole transcript.
      }
    }

    if (records.length === 0) {
      return { store, outcome: { messages: [], rejected: null, recordCount: 0 } };
    }

    const reject = async (reason: "stale" | "too-large"): Promise<{
      store: LedgerStore;
      outcome: LedgerRestoreOutcome;
    }> => {
      // Truncate rather than leave a transcript that will be re-read and
      // re-rejected on every future boot.
      await store.reset();
      return { store, outcome: { messages: [], rejected: reason, recordCount: records.length } };
    };

    if (records.length > options.maxMessages) {
      return reject("too-large");
    }

    const newestAt = Date.parse(records[records.length - 1].at);
    if (Number.isFinite(newestAt) && now - newestAt > options.maxAgeMs) {
      return reject("stale");
    }

    return {
      store,
      outcome: {
        messages: records.map((record) => record.message),
        rejected: null,
        recordCount: records.length,
      },
    };
  }

  /** Serialized so concurrent appends cannot interleave inside one line. */
  async append(message: LlmMessage, at = new Date().toISOString()): Promise<void> {
    const record: LedgerRecord = { at, message };
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
      });
    this.writeQueue = write;
    await write;
  }

  /**
   * Rewrite the log to exactly these turns.
   *
   * Needed because ConversationLedger.restore() drops a transcript's trailing
   * unanswered tool call, which leaves the file holding a turn memory does not
   * have. Left alone, the next boot would read that tool_use back as a *middle*
   * turn — no longer trailing, so no longer dropped — and replay an orphaned id
   * straight into a 400.
   */
  async rewrite(messages: readonly LlmMessage[], at = new Date().toISOString()): Promise<void> {
    const body = messages.map((message) => `${JSON.stringify({ at, message })}\n`).join("");
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, body, "utf-8");
      });
    this.writeQueue = write;
    await write;
  }

  /** Start a new transcript. The old one is gone, not archived. */
  async reset(): Promise<void> {
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, "", "utf-8");
      });
    this.writeQueue = write;
    await write;
  }
}
