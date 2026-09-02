export type TokenUsageBreakdown = {
  inputTokens: number;
  uncachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
};

export type CallTokenUsage = TokenUsageBreakdown & {
  model: string;
  capturedAt: number;
};

export type ModelTokenCounts = TokenUsageBreakdown & {
  // Input recorded before the breakdown schema existed cannot be assigned to a
  // category honestly. Keep it visible instead of pretending it was uncached.
  unattributedInputTokens: number;
};

export type ModelTokenStat = ModelTokenCounts & {
  model: string;
  totalTokens: number;
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

  record(usage: TokenUsageBreakdown): void {
    this.queue.push({
      model: this.model,
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
    outputTokens: tokenCount(record.outputTokens),
  };
}

export function addCallTokenUsage(
  counts: ModelTokenCounts,
  usage: TokenUsageBreakdown,
): ModelTokenCounts {
  return {
    inputTokens: counts.inputTokens + tokenCount(usage.inputTokens),
    uncachedInputTokens: counts.uncachedInputTokens + tokenCount(usage.uncachedInputTokens),
    cacheCreationInputTokens:
      counts.cacheCreationInputTokens + tokenCount(usage.cacheCreationInputTokens),
    cacheReadInputTokens: counts.cacheReadInputTokens + tokenCount(usage.cacheReadInputTokens),
    unattributedInputTokens: counts.unattributedInputTokens,
    outputTokens: counts.outputTokens + tokenCount(usage.outputTokens),
  };
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
      list.push({ model, ...counts, totalTokens: total });
    }
  }
  list.sort((left, right) => right.totalTokens - left.totalTokens);
  return { date, models: list, totalTokens };
}

export type PromptCacheCallSummary = {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
  accountedInputTokens: number;
  // Share of this call's accounted input that was served from cache. Warming
  // only pays for itself when replies read back more than the warm calls wrote,
  // and that is a per-call question the daily totals cannot answer.
  hitRate: number;
};

// Returns null when the provider reported no per-category breakdown (the same
// gap unattributedInputTokens keeps visible): reporting 0% hit for a call that
// was never measured would be a fabricated number, not a miss.
export function summarizePromptCacheCall(
  usage: TokenUsageBreakdown,
): PromptCacheCallSummary | null {
  const uncachedInputTokens = tokenCount(usage.uncachedInputTokens);
  const cacheCreationInputTokens = tokenCount(usage.cacheCreationInputTokens);
  const cacheReadInputTokens = tokenCount(usage.cacheReadInputTokens);
  const accountedInputTokens =
    uncachedInputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  if (accountedInputTokens === 0) {
    return null;
  }

  return {
    cacheReadInputTokens,
    cacheCreationInputTokens,
    uncachedInputTokens,
    accountedInputTokens,
    hitRate: cacheReadInputTokens / accountedInputTokens,
  };
}
