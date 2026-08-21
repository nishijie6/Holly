// Tracks per-domain fetch outcomes for world-observation browsing so page
// selection favors domains that have reliably yielded usable content and
// deprioritizes (or, once proven bad, skips) domains that keep failing —
// a dynamic, data-driven complement to browser-agent.ts's static
// EXCLUDED_SEARCH_DOMAIN_PATTERNS blocklist.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type DomainOutcome = "success" | "failure";

export type DomainStats = {
  success: number;
  failure: number;
  lastOutcomeAt: number;
};

export type DomainReputationSnapshot = Record<string, DomainStats>;

// The interface browser-agent.ts depends on — narrow enough to fake in
// tests, wide enough for DomainReputationStore below to be the real one.
export interface DomainReputationTracker {
  snapshot(): DomainReputationSnapshot;
  record(url: string, outcome: DomainOutcome, now?: number): void;
}

export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Beta(1,1) prior: a domain with no track record scores exactly 0.5 (neither
// favored nor penalized), and a handful of outcomes moves the score
// meaningfully without one bad page permanently burying a domain.
export function domainScore(stats: DomainStats | undefined): number {
  if (!stats) return 0.5;
  return (stats.success + 1) / (stats.success + stats.failure + 2);
}

// Only trust the score enough to hard-skip a domain once it has a real
// track record; a single miss on a domain seen once or twice must not
// exclude it outright — that's what the ranking/deprioritization is for.
const MIN_SAMPLES_TO_SKIP = 4;
const SKIP_SCORE_THRESHOLD = 0.25;

export function shouldSkipDomain(stats: DomainStats | undefined): boolean {
  if (!stats) return false;
  const attempts = stats.success + stats.failure;
  return attempts >= MIN_SAMPLES_TO_SKIP && domainScore(stats) < SKIP_SCORE_THRESHOLD;
}

// Stable sort: higher-confidence domains float to the front so they consume
// browseUrlsWithBrowserAgent's maxPages budget first (the walk loop stops
// once maxPages succeed, so a bad domain sinking to the back naturally gets
// visited less often, without needing to touch that loop). Ties (including
// all-unknown domains) keep the search engine's own ranking as tiebreaker.
// Domains with a proven-bad track record are dropped entirely.
export function rankUrlsByDomainReputation(
  urls: readonly string[],
  snapshot: DomainReputationSnapshot,
): string[] {
  return urls
    .map((url, index) => ({ url, index, domain: extractDomain(url) }))
    .filter(({ domain }) => !(domain && shouldSkipDomain(snapshot[domain])))
    .sort((a, b) => {
      const scoreDiff =
        domainScore(a.domain ? snapshot[a.domain] : undefined) -
        domainScore(b.domain ? snapshot[b.domain] : undefined);
      if (scoreDiff !== 0) return -scoreDiff;
      return a.index - b.index;
    })
    .map((entry) => entry.url);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function coerceStats(value: unknown): DomainStats | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isFiniteNumber(v.success) || !isFiniteNumber(v.failure)) return null;
  return {
    success: Math.max(0, Math.floor(v.success)),
    failure: Math.max(0, Math.floor(v.failure)),
    lastOutcomeAt: isFiniteNumber(v.lastOutcomeAt) ? v.lastOutcomeAt : 0,
  };
}

function coerceSnapshot(raw: unknown): DomainReputationSnapshot {
  const snapshot: DomainReputationSnapshot = {};
  if (!raw || typeof raw !== "object") return snapshot;
  for (const [domain, value] of Object.entries(raw as Record<string, unknown>)) {
    const stats = coerceStats(value);
    if (stats) snapshot[domain] = stats;
  }
  return snapshot;
}

// Persistence mirrors HollyStateStore (holly-state.ts): atomic temp+rename
// write, corrupt/missing file degrades to empty state rather than crashing,
// writes serialized on a queue so overlapping observe_world ticks can't
// interleave.
export class DomainReputationStore implements DomainReputationTracker {
  private data: DomainReputationSnapshot;
  private readonly path: string;
  private saveQueue: Promise<void> = Promise.resolve();

  private constructor(path: string, data: DomainReputationSnapshot) {
    this.path = path;
    this.data = data;
  }

  static async load(path: string): Promise<DomainReputationStore> {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await readFile(path, "utf-8"));
    } catch {
      // Missing or corrupt file → start empty. Never crash the bot.
    }
    return new DomainReputationStore(path, coerceSnapshot(parsed));
  }

  snapshot(): DomainReputationSnapshot {
    return this.data;
  }

  record(url: string, outcome: DomainOutcome, now = Date.now()): void {
    const domain = extractDomain(url);
    if (!domain) return;
    const stats = this.data[domain] ?? { success: 0, failure: 0, lastOutcomeAt: 0 };
    if (outcome === "success") stats.success += 1;
    else stats.failure += 1;
    stats.lastOutcomeAt = now;
    this.data[domain] = stats;
    void this.save();
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.saveQueue = this.saveQueue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp`;
        await writeFile(tmp, snapshot, "utf-8");
        await rename(tmp, this.path);
      })
      .catch((error) => {
        console.error("Failed to persist domain reputation:", error);
      });
    return this.saveQueue;
  }
}
