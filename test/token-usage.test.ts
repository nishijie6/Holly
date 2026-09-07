import assert from "node:assert/strict";
import test from "node:test";

type PromptCacheCounts = {
  calls: number;
  uncacheableCalls: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
  uncacheableInputTokens: number;
  outputTokens: number;
};

type TokenUsageModule = {
  TokenUsageQueue: new (model: string, now?: () => number) => {
    record(usage: {
      inputTokens: number;
      uncachedInputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      outputTokens: number;
    }, purpose: string): void;
    consume(): {
      model: string;
      purpose: string;
      inputTokens: number;
      uncachedInputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      outputTokens: number;
      capturedAt: number;
    } | null;
  };
  normalizeStoredTokenCounts(value: unknown): {
    inputTokens: number;
    uncachedInputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    unattributedInputTokens: number;
    uncacheableInputTokens: number;
    outputTokens: number;
  };
  addCallTokenUsage(
    counts: ReturnType<TokenUsageModule["normalizeStoredTokenCounts"]>,
    usage: {
      inputTokens: number;
      uncachedInputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      outputTokens: number;
    },
    belowMinimum?: boolean,
  ): ReturnType<TokenUsageModule["normalizeStoredTokenCounts"]>;
  minimumCacheablePrefixTokens(model: string): number | null;
  derivePromptCacheHitRate(counts: {
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    uncachedInputTokens: number;
  }): number | null;
  emptyPromptCacheCounts(): PromptCacheCounts;
  addSummaryToPromptCacheCounts(
    counts: PromptCacheCounts,
    summary: NonNullable<ReturnType<TokenUsageModule["summarizePromptCacheCall"]>>,
    outputTokens: number,
  ): PromptCacheCounts;
  buildPromptCacheSeries(
    buckets: Map<string, PromptCacheCounts> | undefined,
    hourKeys: readonly string[],
  ): Array<PromptCacheCounts & { bucket: string; inputTokens: number; hitRate: number | null }>;
  buildPromptCachePurposeStats(
    purposes: Map<string, PromptCacheCounts> | undefined,
  ): Array<PromptCacheCounts & { purpose: string; inputTokens: number; hitRate: number | null }>;
  localHourKey(date: Date): string;
  listRecentHourKeys(now: Date, hours: number): string[];
  summarizePromptCacheCall(usage: {
    inputTokens: number;
    uncachedInputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    outputTokens: number;
  }, model?: string): {
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    uncachedInputTokens: number;
    accountedInputTokens: number;
    hitRate: number | null;
    minimumPrefixTokens: number | null;
    belowMinimum: boolean;
  } | null;
  buildDailyTokenStats(
    date: string,
    models: Map<string, ReturnType<TokenUsageModule["normalizeStoredTokenCounts"]>>,
  ): {
    date: string;
    totalTokens: number;
    models: Array<{
      model: string;
      inputTokens: number;
      uncachedInputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      unattributedInputTokens: number;
      uncacheableInputTokens: number;
      outputTokens: number;
      totalTokens: number;
      hitRate: number | null;
    }>;
  };
};

async function loadUsageModule(): Promise<TokenUsageModule> {
  const candidate = await import("../token-usage.js").catch(() => null);
  assert.ok(candidate, "token-usage module must exist");
  return candidate as unknown as TokenUsageModule;
}

test("legacy aggregate input remains visible as unattributed after schema migration", async () => {
  const { normalizeStoredTokenCounts } = await loadUsageModule();
  assert.deepEqual(normalizeStoredTokenCounts({ inputTokens: 1_000, outputTokens: 20 }), {
    inputTokens: 1_000,
    uncachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    unattributedInputTokens: 1_000,
    uncacheableInputTokens: 0,
    outputTokens: 20,
  });
});

test("new calls accumulate each cache category without losing the legacy aggregate", async () => {
  const { addCallTokenUsage, normalizeStoredTokenCounts } = await loadUsageModule();
  const legacy = normalizeStoredTokenCounts({ inputTokens: 1_000, outputTokens: 20 });

  assert.deepEqual(addCallTokenUsage(legacy, {
    inputTokens: 900,
    uncachedInputTokens: 200,
    cacheCreationInputTokens: 300,
    cacheReadInputTokens: 400,
    outputTokens: 50,
  }), {
    inputTokens: 1_900,
    uncachedInputTokens: 200,
    cacheCreationInputTokens: 300,
    cacheReadInputTokens: 400,
    unattributedInputTokens: 1_000,
    uncacheableInputTokens: 0,
    outputTokens: 70,
  });
});

test("input from a call that could never cache lands outside the hit-rate denominator", async () => {
  const { addCallTokenUsage, derivePromptCacheHitRate, normalizeStoredTokenCounts } = await loadUsageModule();
  const counts = addCallTokenUsage(normalizeStoredTokenCounts({}), {
    inputTokens: 250,
    uncachedInputTokens: 250,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 40,
  }, true);

  assert.equal(counts.uncacheableInputTokens, 250);
  assert.equal(counts.uncachedInputTokens, 0);
  // Nothing cache-eligible was recorded, so there is no rate to report.
  assert.equal(derivePromptCacheHitRate(counts), null);
});

test("daily token stats expose every input category and include output in the total", async () => {
  const { buildDailyTokenStats, normalizeStoredTokenCounts } = await loadUsageModule();
  const counts = normalizeStoredTokenCounts({
    inputTokens: 900,
    uncachedInputTokens: 200,
    cacheCreationInputTokens: 300,
    cacheReadInputTokens: 400,
    unattributedInputTokens: 0,
    outputTokens: 50,
  });

  assert.deepEqual(buildDailyTokenStats("2026-09-02", new Map([["claude-opus-4-7", counts]])), {
    date: "2026-09-02",
    models: [{
      model: "claude-opus-4-7",
      inputTokens: 900,
      uncachedInputTokens: 200,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 400,
      unattributedInputTokens: 0,
      uncacheableInputTokens: 0,
      outputTokens: 50,
      totalTokens: 950,
      // 400 read of the 900 cache-eligible input tokens; output is not input.
      hitRate: 400 / 900,
    }],
    totalTokens: 950,
  });
});

test("per-client token queues cannot overwrite each other and preserve completion order", async () => {
  const { TokenUsageQueue } = await loadUsageModule();
  const firstClient = new TokenUsageQueue("claude-sonnet-4-6", () => 1_000);
  const secondClient = new TokenUsageQueue("claude-sonnet-4-6", () => 2_000);
  const first = {
    inputTokens: 10,
    uncachedInputTokens: 2,
    cacheCreationInputTokens: 3,
    cacheReadInputTokens: 5,
    outputTokens: 1,
  };
  const second = {
    inputTokens: 20,
    uncachedInputTokens: 4,
    cacheCreationInputTokens: 6,
    cacheReadInputTokens: 10,
    outputTokens: 2,
  };

  firstClient.record(first, "reply-decision");
  secondClient.record(second, "context-warm");
  firstClient.record(second, "memory-reflection");

  assert.deepEqual(firstClient.consume(), {
    model: "claude-sonnet-4-6",
    purpose: "reply-decision",
    ...first,
    capturedAt: 1_000,
  });
  assert.deepEqual(secondClient.consume(), {
    model: "claude-sonnet-4-6",
    purpose: "context-warm",
    ...second,
    capturedAt: 2_000,
  });
  assert.deepEqual(firstClient.consume(), {
    model: "claude-sonnet-4-6",
    purpose: "memory-reflection",
    ...second,
    capturedAt: 1_000,
  });
  assert.equal(firstClient.consume(), null);
  assert.equal(secondClient.consume(), null);
});

test("a call's cache hit rate is measured against the input it actually accounted for", async () => {
  const { summarizePromptCacheCall } = await loadUsageModule();
  assert.deepEqual(summarizePromptCacheCall({
    inputTokens: 1_000,
    uncachedInputTokens: 100,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 800,
    outputTokens: 50,
  }, "claude-sonnet-4-6"), {
    cacheReadInputTokens: 800,
    cacheCreationInputTokens: 100,
    uncachedInputTokens: 100,
    accountedInputTokens: 1_000,
    hitRate: 0.8,
    minimumPrefixTokens: 1_024,
    cacheablePrefixTokens: null,
    uncacheableReason: null,
    belowMinimum: false,
  });
});

test("a warm call that only writes cache reports a 0% hit rather than nothing", async () => {
  const { summarizePromptCacheCall } = await loadUsageModule();
  assert.deepEqual(summarizePromptCacheCall({
    inputTokens: 54_643,
    uncachedInputTokens: 0,
    cacheCreationInputTokens: 54_643,
    cacheReadInputTokens: 0,
    outputTokens: 1,
  }, "claude-sonnet-4-6"), {
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 54_643,
    uncachedInputTokens: 0,
    accountedInputTokens: 54_643,
    hitRate: 0,
    minimumPrefixTokens: 1_024,
    cacheablePrefixTokens: null,
    uncacheableReason: null,
    belowMinimum: false,
  });
});

test("a request shorter than the model's minimum reports no rate instead of a 0% miss", async () => {
  const { summarizePromptCacheCall } = await loadUsageModule();
  // The isolated final-reply call: a fixed instruction plus one approved draft,
  // nowhere near opus-4-7's 2048-token minimum cacheable prefix.
  const summary = summarizePromptCacheCall({
    inputTokens: 260,
    uncachedInputTokens: 260,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 40,
  }, "claude-opus-4-7");

  assert.equal(summary?.belowMinimum, true);
  assert.equal(summary?.minimumPrefixTokens, 2_048);
  assert.equal(summary?.hitRate, null);
});

test("cache activity outweighs the table: a short request that did cache is measured normally", async () => {
  const { summarizePromptCacheCall } = await loadUsageModule();
  const summary = summarizePromptCacheCall({
    inputTokens: 600,
    uncachedInputTokens: 100,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 500,
    outputTokens: 10,
  }, "claude-opus-4-7");

  assert.equal(summary?.belowMinimum, false);
  assert.equal(summary?.hitRate, 500 / 600);
});

test("an unknown model is measured rather than excused", async () => {
  const { minimumCacheablePrefixTokens, summarizePromptCacheCall } = await loadUsageModule();
  assert.equal(minimumCacheablePrefixTokens("some-other-model"), null);
  const summary = summarizePromptCacheCall({
    inputTokens: 40,
    uncachedInputTokens: 40,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 5,
  }, "some-other-model");

  assert.equal(summary?.belowMinimum, false);
  assert.equal(summary?.hitRate, 0);
});

test("model minimums are matched most-specific-first", async () => {
  const { minimumCacheablePrefixTokens } = await loadUsageModule();
  assert.equal(minimumCacheablePrefixTokens("claude-opus-4-7"), 2_048);
  assert.equal(minimumCacheablePrefixTokens("claude-opus-4-6"), 4_096);
  assert.equal(minimumCacheablePrefixTokens("claude-opus-4-8"), 1_024);
  assert.equal(minimumCacheablePrefixTokens("claude-opus-5"), 512);
  assert.equal(minimumCacheablePrefixTokens("claude-sonnet-4-6"), 1_024);
});

test("a call with no reported breakdown is unmeasured, not a cache miss", async () => {
  const { summarizePromptCacheCall } = await loadUsageModule();
  assert.equal(summarizePromptCacheCall({
    inputTokens: 12_000,
    uncachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 30,
  }), null);
});

test("each queued call keeps the purpose it was made for, in completion order", async () => {
  const { TokenUsageQueue } = await loadUsageModule();
  const client = new TokenUsageQueue("claude-sonnet-4-6", () => 1_000);
  const usage = {
    inputTokens: 10,
    uncachedInputTokens: 2,
    cacheCreationInputTokens: 3,
    cacheReadInputTokens: 5,
    outputTokens: 1,
  };

  // A warm and the reply that reads it back are the same model on the same
  // client: only the purpose tells the write apart from the read it paid for.
  client.record(usage, "context-warm");
  client.record(usage, "reply-decision");

  assert.equal(client.consume()?.purpose, "context-warm");
  assert.equal(client.consume()?.purpose, "reply-decision");
  assert.equal(client.consume(), null);
});

test("the hourly series keeps empty hours as gaps instead of dropping them", async () => {
  const { buildPromptCacheSeries, emptyPromptCacheCounts, listRecentHourKeys } = await loadUsageModule();
  const now = new Date(2026, 8, 3, 14, 30);
  const keys = listRecentHourKeys(now, 3);
  assert.deepEqual(keys, ["2026-09-03T12", "2026-09-03T13", "2026-09-03T14"]);

  const buckets = new Map([[
    "2026-09-03T14",
    {
      ...emptyPromptCacheCounts(),
      calls: 4,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 100,
      uncachedInputTokens: 0,
    },
  ]]);
  const series = buildPromptCacheSeries(buckets, keys);

  assert.equal(series.length, 3);
  // An hour Holly spent asleep has no rate — not a 0% that would drag a chart
  // (or an average) down with silence.
  assert.equal(series[0].hitRate, null);
  assert.equal(series[2].hitRate, 0.9);
  assert.equal(series[2].inputTokens, 1_000);
});

test("the purpose rollup separates what warming wrote from what replies read back", async () => {
  const {
    addSummaryToPromptCacheCounts,
    buildPromptCachePurposeStats,
    emptyPromptCacheCounts,
    summarizePromptCacheCall,
  } = await loadUsageModule();

  const warm = summarizePromptCacheCall({
    inputTokens: 50_000,
    uncachedInputTokens: 0,
    cacheCreationInputTokens: 50_000,
    cacheReadInputTokens: 0,
    outputTokens: 1,
  }, "claude-sonnet-4-6");
  const reply = summarizePromptCacheCall({
    inputTokens: 51_000,
    uncachedInputTokens: 1_000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 50_000,
    outputTokens: 200,
  }, "claude-sonnet-4-6");
  assert.ok(warm && reply);

  const stats = buildPromptCachePurposeStats(new Map([
    ["context-warm", addSummaryToPromptCacheCounts(emptyPromptCacheCounts(), warm, 1)],
    ["reply-decision", addSummaryToPromptCacheCounts(emptyPromptCacheCounts(), reply, 200)],
  ]));

  const byPurpose = Object.fromEntries(stats.map((stat) => [stat.purpose, stat]));
  assert.equal(byPurpose["context-warm"].hitRate, 0);
  assert.equal(byPurpose["context-warm"].cacheCreationInputTokens, 50_000);
  assert.equal(byPurpose["reply-decision"].cacheReadInputTokens, 50_000);
  // The warm paid for itself here: the reply read back everything it wrote.
  assert.ok(byPurpose["reply-decision"].hitRate! > 0.98);
});

test("uncacheable calls are counted but never diluted into the rate", async () => {
  const {
    addSummaryToPromptCacheCounts,
    buildPromptCachePurposeStats,
    emptyPromptCacheCounts,
    summarizePromptCacheCall,
  } = await loadUsageModule();

  const draft = summarizePromptCacheCall({
    inputTokens: 260,
    uncachedInputTokens: 260,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 40,
  }, "claude-opus-4-7");
  assert.ok(draft);

  const [stat] = buildPromptCachePurposeStats(new Map([
    ["reply-response", addSummaryToPromptCacheCounts(emptyPromptCacheCounts(), draft, 40)],
  ]));

  assert.equal(stat.calls, 1);
  assert.equal(stat.uncacheableCalls, 1);
  assert.equal(stat.uncacheableInputTokens, 260);
  assert.equal(stat.uncachedInputTokens, 0);
  assert.equal(stat.hitRate, null);
});

test("a large request with a tiny prefix is a fixable miss, not an excused one", async () => {
  const { summarizePromptCacheCall } = await loadUsageModule();
  // memory-reflection as it actually ran: 11k tokens on the wire, but the
  // breakpoint sat on a 40-token system constant, so no entry could exist.
  const summary = summarizePromptCacheCall({
    inputTokens: 11_112,
    uncachedInputTokens: 11_112,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 123,
    cacheablePrefixTokens: 40,
  }, "claude-opus-4-7");

  assert.equal(summary?.uncacheableReason, "prefix-too-small");
  assert.equal(summary?.cacheablePrefixTokens, 40);
  // Still a miss: unlike a request that is simply too small, this one had 11k
  // tokens a correctly placed breakpoint could have covered.
  assert.equal(summary?.belowMinimum, false);
  assert.equal(summary?.hitRate, 0);
});

test("a request under the minimum stays excused even when the prefix is measured", async () => {
  const { summarizePromptCacheCall } = await loadUsageModule();
  // autonomy-judgment: 711 tokens total, under sonnet-4-6's 1024. No breakpoint
  // placement could rescue this one.
  const summary = summarizePromptCacheCall({
    inputTokens: 711,
    uncachedInputTokens: 711,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 47,
    cacheablePrefixTokens: 30,
  }, "claude-sonnet-4-6");

  assert.equal(summary?.uncacheableReason, "request-too-small");
  assert.equal(summary?.belowMinimum, true);
  assert.equal(summary?.hitRate, null);
});

test("a prefix that clears the minimum but missed is left as a plain miss", async () => {
  const { summarizePromptCacheCall } = await loadUsageModule();
  const summary = summarizePromptCacheCall({
    inputTokens: 20_000,
    uncachedInputTokens: 20_000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 100,
    cacheablePrefixTokens: 8_000,
  }, "claude-opus-4-7");

  // Nothing structural excuses this one — the prefix was big enough, so it
  // really is drift, and the report should keep pointing there.
  assert.equal(summary?.uncacheableReason, null);
  assert.equal(summary?.hitRate, 0);
});

test("cache activity outranks the prefix estimate", async () => {
  const { summarizePromptCacheCall } = await loadUsageModule();
  // The estimate is deliberately coarse; a real cache read proves the request
  // cleared the minimum whatever the arithmetic said.
  const summary = summarizePromptCacheCall({
    inputTokens: 5_000,
    uncachedInputTokens: 1_000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 4_000,
    outputTokens: 60,
    cacheablePrefixTokens: 100,
  }, "claude-opus-4-7");

  assert.equal(summary?.uncacheableReason, null);
  assert.equal(summary?.hitRate, 0.8);
});
