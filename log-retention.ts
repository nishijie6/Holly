// What Holly is allowed to throw away, and what it must not.
//
// Nothing here deletes a line that anything still reads. Each JSONL log is
// trimmed to a bound comfortably above what the code restores from it — the
// world-observation log is read back capped at 128 entries, the memory sidebar
// at 12 — so trimming to thousands cannot change behaviour, only disk.
//
// Two rules that keep this boring:
//   - JSONL logs are TRUNCATED to their newest lines, never deleted. A file that
//     still exists and still has its recent history cannot surprise anyone.
//   - Only the per-session transcripts are deleted, only when both older than
//     the age bound and outside the keep-newest window, and never the session
//     currently being written.
//
// Deliberately out of scope: launchd.err.log / launchd.out.log and the leftover
// pm2 logs. Those file descriptors belong to a supervisor that is appending to
// them right now; rewriting a file under a live append-mode writer races, and
// the supervisor is the right place to rotate them.

export type JsonlRetentionRule = {
  /** File name inside the log directory. */
  file: string;
  /** Newest lines to keep. Must exceed anything the code restores from it. */
  keepLines: number;
  /** What reads this back, so a future reader can check the bound is still safe. */
  readBy: string;
};

export const JSONL_RETENTION_RULES: readonly JsonlRetentionRule[] = [
  // The highest-volume log here: every monitor entry, and there are 153 call
  // sites. Kept longest anyway — it is the one people read after an incident.
  { file: "monitor.jsonl", keepLines: 20_000, readBy: "nothing at runtime — for post-incident reading" },
  { file: "thought-history.jsonl", keepLines: 5_000, readBy: "ThoughtHistoryStore (in-memory cap ~400)" },
  { file: "world-observations.jsonl", keepLines: 2_000, readBy: "loadWorldObservationMemory (cap 128)" },
  { file: "holly-memories.jsonl", keepLines: 2_000, readBy: "memory sidebar (slice(-12))" },
  { file: "boot-thoughts.jsonl", keepLines: 1_000, readBy: "nothing — write-only" },
  { file: "proactive-shadow.jsonl", keepLines: 2_000, readBy: "nothing — write-only shadow log" },
];

export type SessionLogFile = {
  name: string;
  modifiedAtMs: number;
};

export type SessionLogPruneOptions = {
  /** Always keep this many newest transcripts, whatever their age. */
  keepNewest: number;
  /** Older than this AND outside the keep window before anything is deleted. */
  maxAgeMs: number;
  /** The transcript this process is writing. Never a candidate. */
  activeFile: string | null;
  now: number;
};

export const DEFAULT_SESSION_LOG_PRUNE: Omit<SessionLogPruneOptions, "activeFile" | "now"> = {
  keepNewest: 40,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Which session transcripts may be deleted.
 *
 * Both bounds must agree before a file goes: age alone would wipe a long-idle
 * install's whole history on first run, and a keep-newest count alone would
 * delete files that are only days old whenever restarts come in a burst — and
 * restarts do come in bursts, which is exactly how ~140 of these accumulated.
 */
export function planSessionLogPrune(
  files: readonly SessionLogFile[],
  options: SessionLogPruneOptions,
): string[] {
  const keepNewest = Math.max(0, Math.floor(options.keepNewest));
  const newestFirst = [...files].sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  const cutoff = options.now - options.maxAgeMs;

  return newestFirst
    .slice(keepNewest)
    .filter((file) => file.name !== options.activeFile)
    .filter((file) => file.modifiedAtMs < cutoff)
    .map((file) => file.name);
}

/** The newest `keepLines` lines, or null when the file is already within bound. */
export function trimJsonlContent(raw: string, keepLines: number): string | null {
  const lines = raw.split("\n");
  // A trailing newline yields a final empty element; it is not a record.
  const hasTrailingNewline = lines[lines.length - 1] === "";
  const records = hasTrailingNewline ? lines.slice(0, -1) : lines;
  if (records.length <= keepLines) {
    return null;
  }
  return `${records.slice(-keepLines).join("\n")}\n`;
}
