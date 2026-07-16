// Persisted merged conversation timeline. The in-memory
// conversationHistoryByGroup map is snapshotted to disk so a service restart
// keeps the whole context: the day-history bootstrap only recovers TODAY's
// messages, lazily per group, so without this file every restart dropped all
// cross-day history and left quiet groups empty.
// 持久化:原子写(temp + rename),损坏 JSON → 空上下文不崩(与 holly-state 同款硬化)。

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// Structurally identical to main.ts's ConversationTurn; declared here so the
// store stays importable by tests without pulling in main.ts's bootstrap.
export type PersistedConversationTurn = {
  groupId: string | null;
  role: "user" | "assistant";
  senderName: string | null;
  userId: string | null;
  content: string;
  timestamp: string;
  messageId?: string | null;
};

// Bounds file growth: memory keeps the full per-group history, but only the
// most recent turns per group survive a restart. Generous relative to the
// request-time context budget, which is what actually limits the model.
export const MAX_PERSISTED_TURNS_PER_GROUP = 2000;

function coerceTurn(value: unknown): PersistedConversationTurn | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const role = record.role;
  if (role !== "user" && role !== "assistant") {
    return null;
  }

  const content = typeof record.content === "string" ? record.content.trim() : "";
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
  if (!content || !timestamp || Number.isNaN(Date.parse(timestamp))) {
    return null;
  }

  return {
    groupId: typeof record.groupId === "string" ? record.groupId : null,
    role,
    senderName: typeof record.senderName === "string" ? record.senderName : null,
    userId: typeof record.userId === "string" ? record.userId : null,
    content,
    timestamp,
    messageId: typeof record.messageId === "string" ? record.messageId : null,
  };
}

export class ConversationContextStore {
  private readonly path: string;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  // Missing or corrupt file → empty context. Never crash the bot. Invalid
  // entries inside an otherwise valid file are skipped turn-by-turn.
  async load(): Promise<Map<string, PersistedConversationTurn[]>> {
    const result = new Map<string, PersistedConversationTurn[]>();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf-8"));
    } catch {
      return result;
    }

    const groups = typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).groups
      : null;
    if (typeof groups !== "object" || groups === null) {
      return result;
    }

    for (const [groupId, turns] of Object.entries(groups as Record<string, unknown>)) {
      if (!groupId || !Array.isArray(turns)) {
        continue;
      }
      const coerced = turns
        .map(coerceTurn)
        .filter((turn): turn is PersistedConversationTurn => turn !== null);
      if (coerced.length > 0) {
        result.set(groupId, coerced);
      }
    }

    return result;
  }

  // Atomic, serialized persistence. temp + rename so a crash mid-write can never
  // leave a half-file (which corrupt-safe load would then discard anyway).
  save(historyByGroup: ReadonlyMap<string, readonly PersistedConversationTurn[]>): Promise<void> {
    const groups: Record<string, readonly PersistedConversationTurn[]> = {};
    for (const [groupId, turns] of historyByGroup) {
      if (turns.length === 0) {
        continue;
      }
      groups[groupId] = turns.slice(-MAX_PERSISTED_TURNS_PER_GROUP);
    }

    const snapshot = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), groups });
    this.saveQueue = this.saveQueue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp`;
        await writeFile(tmp, snapshot, "utf-8");
        await rename(tmp, this.path);
      })
      .catch((error) => {
        console.error("Failed to persist conversation context:", error);
      });
    return this.saveQueue;
  }
}
