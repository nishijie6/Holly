import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ThoughtKind = "bootstrap" | "qq_mode" | "reactive" | "proactive";

export type ThoughtEntry = {
  id: string;
  timestamp: string;
  kind: ThoughtKind;
  title: string;
  summary: string;
  groupId: string | null;
  outcome: string;
  finalAnswer: string;
  model: string;
  durationMs: number | null;
};

export type ThoughtEntryInput = Omit<ThoughtEntry, "id" | "timestamp"> & {
  id?: string;
  timestamp?: string;
};

const THOUGHT_KINDS = new Set<ThoughtKind>(["bootstrap", "qq_mode", "reactive", "proactive"]);

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function coerceThoughtEntry(value: unknown): ThoughtEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = THOUGHT_KINDS.has(raw.kind as ThoughtKind) ? raw.kind as ThoughtKind : null;
  const summary = cleanText(raw.summary, 4000);
  if (!kind || !summary) return null;

  const timestampValue = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
  const timestamp = Number.isFinite(timestampValue)
    ? new Date(timestampValue).toISOString()
    : new Date().toISOString();
  const durationValue = typeof raw.durationMs === "number"
    ? raw.durationMs
    : typeof raw.durationMs === "string" && raw.durationMs.trim()
      ? Number(raw.durationMs)
      : NaN;

  return {
    id: cleanText(raw.id, 160) || randomUUID(),
    timestamp,
    kind,
    title: cleanText(raw.title, 240) || kind,
    summary,
    groupId: cleanText(raw.groupId, 160) || null,
    outcome: cleanText(raw.outcome, 240),
    finalAnswer: cleanText(raw.finalAnswer, 4000),
    model: cleanText(raw.model, 240),
    durationMs: Number.isFinite(durationValue) && durationValue >= 0 ? Math.round(durationValue) : null,
  };
}

export class ThoughtHistoryStore {
  private entries: ThoughtEntry[];
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly limit: number,
    entries: ThoughtEntry[],
  ) {
    this.entries = entries.slice(-limit);
  }

  static async load(filePath: string, limit = 400): Promise<ThoughtHistoryStore> {
    const normalizedLimit = Math.max(1, Math.floor(limit));
    let raw = "";
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      return new ThoughtHistoryStore(filePath, normalizedLimit, []);
    }

    const entries: ThoughtEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = coerceThoughtEntry(JSON.parse(trimmed));
        if (entry) entries.push(entry);
      } catch {
        // A single partial/corrupt JSONL line must not hide the rest of the timeline.
      }
    }
    return new ThoughtHistoryStore(filePath, normalizedLimit, entries);
  }

  list(limit = this.limit): ThoughtEntry[] {
    const normalizedLimit = Math.max(1, Math.min(this.limit, Math.floor(limit)));
    return this.entries.slice(-normalizedLimit).map((entry) => ({ ...entry }));
  }

  async append(input: ThoughtEntryInput): Promise<ThoughtEntry> {
    const entry = coerceThoughtEntry({
      ...input,
      id: input.id || randomUUID(),
      timestamp: input.timestamp || new Date().toISOString(),
    });
    if (!entry) {
      throw new Error("Thought entry requires a valid kind and non-empty summary.");
    }

    this.entries = [...this.entries.slice(-(this.limit - 1)), entry];
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
      });
    this.writeQueue = write;
    await write;
    return { ...entry };
  }
}
