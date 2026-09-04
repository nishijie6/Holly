// Every LLM call declares why it was made, and that label rides along with the
// usage it produces. "Did the warm pass pay for the reply that followed" is a
// question about which call read the cache — the daily totals cannot answer it,
// and a label attached at the consuming end drifts from the call that earned it.
export type LlmCallPurpose =
  | "reply-decision"
  | "reply-response"
  | "reply-search-reask"
  | "context-warm"
  | "world-observation-broadcast"
  | "memory-reflection"
  | "archive-composition"
  | "proactive-decision"
  | "proactive-response"
  | "boot-orientation"
  | "qq-mode-decision"
  | "autonomy-judgment"
  | "eval-script";

export type TokenUsageBreakdown = {
  inputTokens: number;
  uncachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
};

export type CallTokenUsage = TokenUsageBreakdown & {
  model: string;
  purpose: LlmCallPurpose;
  capturedAt: number;
};

export type ModelTokenCounts = TokenUsageBreakdown & {
  // Input recorded before the breakdown schema existed cannot be assigned to a
  // category honestly. Keep it visible instead of pretending it was uncached.
  unattributedInputTokens: number;
  // Input from calls whose whole request was shorter than the model's minimum
  // cacheable prefix. It is uncached, but no prefix work could ever have
  // cached it, so it stays out of the hit-rate denominator (see
  // minimumCacheablePrefixTokens) instead of reading as a fixable miss.
  uncacheableInputTokens: number;
};

export type ModelTokenStat = ModelTokenCounts & {
  model: string;
  totalTokens: number;
  // read / (read + write + uncached); null when the model has no cache-eligible
  // input on record, which is not the same as a 0% hit.
  hitRate: number | null;
};

export type DailyTokenStats = {
  date: string;
  models: ModelTokenStat[];
  totalTokens: number;
};

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export class TokenUsageQueue {
  private readonly model: string;
  private readonly now: () => number;
  private readonly queue: CallTokenUsage[] = [];

  constructor(model: string, now: () => number = () => Date.now()) {
    this.model = model;
    this.now = now;
  }

  record(usage: TokenUsageBreakdown, purpose: LlmCallPurpose): void {
    this.queue.push({
      model: this.model,
      purpose,
      inputTokens: tokenCount(usage.inputTokens),
      uncachedInputTokens: tokenCount(usage.uncachedInputTokens),
      cacheCreationInputTokens: tokenCount(usage.cacheCreationInputTokens),
      cacheReadInputTokens: tokenCount(usage.cacheReadInputTokens),
      outputTokens: tokenCount(usage.outputTokens),
      capturedAt: this.now(),
    });
  }

  consume(): CallTokenUsage | null {
    return this.queue.shift() ?? null;
  }
}

export function normalizeStoredTokenCounts(value: unknown): ModelTokenCounts {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const inputTokens = tokenCount(record.inputTokens);
  const uncachedInputTokens = tokenCount(record.uncachedInputTokens);
  const cacheCreationInputTokens = tokenCount(record.cacheCreationInputTokens);
  const cacheReadInputTokens = tokenCount(record.cacheReadInputTokens);
  const categorized = uncachedInputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const unattributedInputTokens = "unattributedInputTokens" in record
    ? tokenCount(record.unattributedInputTokens)
    : Math.max(0, inputTokens - categorized);

  return {
    inputTokens,
    uncachedInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    unattributedInputTokens,
    // Absent from rows written before the bucket existed: those calls were
    // measured as plain misses and stay that way rather than being
    // retroactively excused.
    uncacheableInputTokens: tokenCount(record.uncacheableInputTokens),
    outputTokens: tokenCount(record.outputTokens),
  };
}

// belowMinimum routes this call's input to the uncacheable bucket instead of
// the uncached one. Both are "not served from cache", but only the uncached
// bucket is a miss a better prefix could have prevented, and only it belongs
// in the hit-rate denominator.
export function addCallTokenUsage(
  counts: ModelTokenCounts,
  usage: TokenUsageBreakdown,
  belowMinimum = false,
): ModelTokenCounts {
  const uncached = tokenCount(usage.uncachedInputTokens);
  return {
    inputTokens: counts.inputTokens + tokenCount(usage.inputTokens),
    uncachedInputTokens: counts.uncachedInputTokens + (belowMinimum ? 0 : uncached),
    cacheCreationInputTokens:
      counts.cacheCreationInputTokens + tokenCount(usage.cacheCreationInputTokens),
    cacheReadInputTokens: counts.cacheReadInputTokens + tokenCount(usage.cacheReadInputTokens),
    unattributedInputTokens: counts.unattributedInputTokens,
    uncacheableInputTokens: counts.uncacheableInputTokens + (belowMinimum ? uncached : 0),
    outputTokens: counts.outputTokens + tokenCount(usage.outputTokens),
  };
}

// The one place the ratio is defined. Every surface (per-call entry, daily
// table, hourly series, per-purpose rollup) derives its percentage here, so
// the number cannot mean one thing on the dashboard and another in a log line.
export function derivePromptCacheHitRate(counts: {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
}): number | null {
  const read = tokenCount(counts.cacheReadInputTokens);
  const eligible = read
    + tokenCount(counts.cacheCreationInputTokens)
    + tokenCount(counts.uncachedInputTokens);
  return eligible === 0 ? null : read / eligible;
}

export function buildDailyTokenStats(
  date: string,
  models: Map<string, ModelTokenCounts> | undefined,
): DailyTokenStats {
  const list: ModelTokenStat[] = [];
  let totalTokens = 0;
  if (models) {
    for (const [model, counts] of models) {
      const total = counts.inputTokens + counts.outputTokens;
      totalTokens += total;
      list.push({ model, ...counts, totalTokens: total, hitRate: derivePromptCacheHitRate(counts) });
    }
  }
  list.sort((left, right) => right.totalTokens - left.totalTokens);
  return { date, models: list, totalTokens };
}

// Anthropic silently declines to cache a prefix shorter than a per-model
// minimum: no error, just cache_creation_input_tokens: 0 forever. The minimum
// is not monotonic across generations, so it has to be a table, not a rule of
// thumb. Unknown models return null — a call is only excused from the hit-rate
// denominator when we actually know the threshold it fell under.
const MINIMUM_CACHEABLE_PREFIX_TOKENS: ReadonlyArray<readonly [prefix: string, minimum: number]> = [
  ["claude-opus-4-8", 1_024],
  ["claude-opus-4-7", 2_048],
  ["claude-opus-4-6", 4_096],
  ["claude-opus-4-5", 4_096],
  ["claude-opus-4-1", 1_024],
  ["claude-opus-5", 512],
  ["claude-opus-4", 1_024],
  ["claude-fable-5", 512],
  ["claude-mythos-5", 512],
  ["claude-sonnet-5", 1_024],
  ["claude-sonnet-4-6", 1_024],
  ["claude-sonnet-4-5", 1_024],
  ["claude-sonnet-4", 1_024],
  ["claude-haiku-4-5", 4_096],
  ["claude-haiku-3-5", 2_048],
];

export function minimumCacheablePrefixTokens(model: string): number | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  // Longest-first order matters: "claude-opus-4-7" must not be answered by the
  // "claude-opus-4" row.
  for (const [prefix, minimum] of MINIMUM_CACHEABLE_PREFIX_TOKENS) {
    if (normalized.startsWith(prefix)) return minimum;
  }
  return null;
}

export type PromptCacheCallSummary = {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
  accountedInputTokens: number;
  // Share of this call's accounted input that was served from cache. Warming
  // only pays for itself when replies read back more than the warm calls wrote,
  // and that is a per-call question the daily totals cannot answer. null when
  // the call was never eligible to cache (belowMinimum).
  hitRate: number | null;
  // The model's minimum cacheable prefix, or null when the model is not in the
  // table above.
  minimumPrefixTokens: number | null;
  // The whole request was shorter than that minimum, so no cache entry could
  // exist no matter how stable the prefix was. Reporting 0% for these calls
  // blames prefix drift for a length problem and buries the routes that are
  // genuinely missing.
  belowMinimum: boolean;
};

// Returns null when the provider reported no per-category breakdown (the same
// gap unattributedInputTokens keeps visible): reporting 0% hit for a call that
// was never measured would be a fabricated number, not a miss.
export function summarizePromptCacheCall(
  usage: TokenUsageBreakdown,
  model = "",
): PromptCacheCallSummary | null {
  const uncachedInputTokens = tokenCount(usage.uncachedInputTokens);
  const cacheCreationInputTokens = tokenCount(usage.cacheCreationInputTokens);
  const cacheReadInputTokens = tokenCount(usage.cacheReadInputTokens);
  const accountedInputTokens =
    uncachedInputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  if (accountedInputTokens === 0) {
    return null;
  }

  const minimumPrefixTokens = minimumCacheablePrefixTokens(model);
  // Any cache activity at all proves the request cleared the minimum, whatever
  // the table says — trust the measurement over the table.
  const belowMinimum = minimumPrefixTokens !== null
    && cacheReadInputTokens === 0
    && cacheCreationInputTokens === 0
    && accountedInputTokens < minimumPrefixTokens;

  return {
    cacheReadInputTokens,
    cacheCreationInputTokens,
    uncachedInputTokens,
    accountedInputTokens,
    hitRate: belowMinimum ? null : cacheReadInputTokens / accountedInputTokens,
    minimumPrefixTokens,
    belowMinimum,
  };
}

// A time bucket (one hour) or one call purpose, counted the same way so the
// hourly series and the per-purpose rollup share a denominator definition.
export type PromptCacheCounts = {
  calls: number;
  uncacheableCalls: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
  uncacheableInputTokens: number;
  outputTokens: number;
};

export function emptyPromptCacheCounts(): PromptCacheCounts {
  return {
    calls: 0,
    uncacheableCalls: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    uncachedInputTokens: 0,
    uncacheableInputTokens: 0,
    outputTokens: 0,
  };
}

export function normalizeStoredPromptCacheCounts(value: unknown): PromptCacheCounts {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    calls: tokenCount(record.calls),
    uncacheableCalls: tokenCount(record.uncacheableCalls),
    cacheReadInputTokens: tokenCount(record.cacheReadInputTokens),
    cacheCreationInputTokens: tokenCount(record.cacheCreationInputTokens),
    uncachedInputTokens: tokenCount(record.uncachedInputTokens),
    uncacheableInputTokens: tokenCount(record.uncacheableInputTokens),
    outputTokens: tokenCount(record.outputTokens),
  };
}

export function addSummaryToPromptCacheCounts(
  counts: PromptCacheCounts,
  summary: PromptCacheCallSummary,
  outputTokens: number,
): PromptCacheCounts {
  return {
    calls: counts.calls + 1,
    uncacheableCalls: counts.uncacheableCalls + (summary.belowMinimum ? 1 : 0),
    cacheReadInputTokens: counts.cacheReadInputTokens + summary.cacheReadInputTokens,
    cacheCreationInputTokens: counts.cacheCreationInputTokens + summary.cacheCreationInputTokens,
    uncachedInputTokens:
      counts.uncachedInputTokens + (summary.belowMinimum ? 0 : summary.uncachedInputTokens),
    uncacheableInputTokens:
      counts.uncacheableInputTokens + (summary.belowMinimum ? summary.uncachedInputTokens : 0),
    outputTokens: counts.outputTokens + tokenCount(outputTokens),
  };
}

export type PromptCacheStat = PromptCacheCounts & {
  inputTokens: number;
  hitRate: number | null;
};

function toPromptCacheStat(counts: PromptCacheCounts): PromptCacheStat {
  return {
    ...counts,
    inputTokens: counts.cacheReadInputTokens
      + counts.cacheCreationInputTokens
      + counts.uncachedInputTokens
      + counts.uncacheableInputTokens,
    hitRate: derivePromptCacheHitRate(counts),
  };
}

export type PromptCacheSeriesPoint = PromptCacheStat & { bucket: string };

// Local-time hour key. The series is read next to the daily table, which is
// also local-time, so both have to agree on where a day starts.
export function localHourKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}`;
}

// Oldest first, one entry per hour with no gaps: an hour Holly spent asleep is
// a point with hitRate null, not a missing x-axis step that silently splices
// two distant hours together.
export function listRecentHourKeys(now: Date, hours: number): string[] {
  const count = Math.max(1, Math.floor(hours));
  const anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    keys.push(localHourKey(new Date(anchor.getTime() - offset * 3_600_000)));
  }
  return keys;
}

export function buildPromptCacheSeries(
  buckets: Map<string, PromptCacheCounts> | undefined,
  hourKeys: readonly string[],
): PromptCacheSeriesPoint[] {
  return hourKeys.map((bucket) => ({
    bucket,
    ...toPromptCacheStat(buckets?.get(bucket) ?? emptyPromptCacheCounts()),
  }));
}

export type PromptCachePurposeStat = PromptCacheStat & { purpose: string };

// "Did the warm pass pay for the replies that followed" is answered by reading
// context-warm's write column against the reply purposes' read column, which
// is why the rollup keeps every purpose rather than a single total.
export function buildPromptCachePurposeStats(
  purposes: Map<string, PromptCacheCounts> | undefined,
): PromptCachePurposeStat[] {
  const list: PromptCachePurposeStat[] = [];
  if (purposes) {
    for (const [purpose, counts] of purposes) {
      list.push({ purpose, ...toPromptCacheStat(counts) });
    }
  }
  list.sort((left, right) => right.inputTokens - left.inputTokens);
  return list;
}
