import assert from "node:assert/strict";
import test from "node:test";

type TokenUsageModule = {
  TokenUsageQueue: new (model: string, now?: () => number) => {
    record(usage: {
      inputTokens: number;
      uncachedInputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
      outputTokens: number;
    }): void;
    consume(): {
      model: string;
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
  ): ReturnType<TokenUsageModule["normalizeStoredTokenCounts"]>;
  summarizePromptCacheCall(usage: {
    inputTokens: number;
    uncachedInputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    outputTokens: number;
  }): {
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    uncachedInputTokens: number;
    accountedInputTokens: number;
    hitRate: number;
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
      outputTokens: number;
      totalTokens: number;
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
    outputTokens: 70,
  });
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
      outputTokens: 50,
      totalTokens: 950,
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

  firstClient.record(first);
  secondClient.record(second);
  firstClient.record(second);

  assert.deepEqual(firstClient.consume(), {
    model: "claude-sonnet-4-6",
    ...first,
    capturedAt: 1_000,
  });
  assert.deepEqual(secondClient.consume(), {
    model: "claude-sonnet-4-6",
    ...second,
    capturedAt: 2_000,
  });
  assert.deepEqual(firstClient.consume(), {
    model: "claude-sonnet-4-6",
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
  }), {
    cacheReadInputTokens: 800,
    cacheCreationInputTokens: 100,
    uncachedInputTokens: 100,
    accountedInputTokens: 1_000,
    hitRate: 0.8,
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
  }), {
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 54_643,
    uncachedInputTokens: 0,
    accountedInputTokens: 54_643,
    hitRate: 0,
  });
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
