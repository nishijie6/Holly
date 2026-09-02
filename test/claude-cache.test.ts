import assert from "node:assert/strict";
import test from "node:test";

import * as llmClientModule from "../llm-client.js";
import type { LlmMessage } from "../llm-client.js";

type ClaudeRequestOptionsForTest = {
  maxTokens?: number;
  cacheStablePrefix?: boolean;
  volatileTailMessages?: number;
};

type ClaudeRequestBuilder = (
  model: string,
  systemPrompt: string,
  messages: LlmMessage[],
  options?: ClaudeRequestOptionsForTest,
) => Record<string, unknown>;

type ClaudeUsageReader = (data: unknown) => {
  inputTokens: number;
  uncachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
} | null;

type ClaudeWarmPreparer = (messages: LlmMessage[]) => {
  messages: LlmMessage[];
  options: ClaudeRequestOptionsForTest;
};

function requestBuilder(): ClaudeRequestBuilder {
  const candidate = (llmClientModule as unknown as Record<string, unknown>).buildClaudeRequestBody;
  assert.equal(typeof candidate, "function", "llm-client must expose the production Claude request builder");
  return candidate as ClaudeRequestBuilder;
}

function usageReader(): ClaudeUsageReader {
  const candidate = (llmClientModule as unknown as Record<string, unknown>).readClaudeUsageTokens;
  assert.equal(typeof candidate, "function", "llm-client must expose its production usage normalizer");
  return candidate as ClaudeUsageReader;
}

function warmPreparer(): ClaudeWarmPreparer {
  const candidate = (llmClientModule as unknown as Record<string, unknown>).prepareClaudeCacheWarmRequest;
  assert.equal(typeof candidate, "function", "llm-client must expose the production warm-request preparer");
  return candidate as ClaudeWarmPreparer;
}

function contentBlocks(body: Record<string, unknown>): Array<Array<Record<string, unknown>>> {
  return (body.messages as Array<{ content: Array<Record<string, unknown>> }>).map(
    (message) => message.content,
  );
}

test("Claude chat caching marks the last stable block and leaves the volatile tail uncached", () => {
  const buildClaudeRequestBody = requestBuilder();
  const body = buildClaudeRequestBody(
    "claude-opus-4-7",
    "stable system prompt",
    [
      { role: "user", content: "older user turn" },
      { role: "assistant", content: "older assistant turn" },
      { role: "user", content: "current_time=changes every request" },
    ],
    { cacheStablePrefix: true, volatileTailMessages: 1 },
  );

  const blocks = contentBlocks(body);
  assert.deepEqual(blocks[1][0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(blocks[2][0].cache_control, undefined);
  assert.equal(body.cache_control, undefined);
});

test("Claude cache warming writes the stable history with zero generated tokens", () => {
  const buildClaudeRequestBody = requestBuilder();
  const prepareClaudeCacheWarmRequest = warmPreparer();
  const prepared = prepareClaudeCacheWarmRequest([
    { role: "user", content: "stable user history" },
    { role: "assistant", content: "stable assistant history" },
  ]);
  const body = buildClaudeRequestBody(
    "claude-opus-4-7",
    "stable system prompt",
    prepared.messages,
    prepared.options,
  );

  const blocks = contentBlocks(body);
  assert.equal(body.max_tokens, 0);
  assert.deepEqual(blocks[1][0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(blocks[2][0].text, "warmup");
  assert.equal(blocks[2][0].cache_control, undefined);
  assert.equal(body.cache_control, undefined);
});

test("Claude usage keeps uncached input, cache creation, and cache reads separate", () => {
  const readClaudeUsageTokens = usageReader();
  assert.deepEqual(readClaudeUsageTokens({
    usage: {
      input_tokens: 200,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 400,
      output_tokens: 50,
    },
  }), {
    inputTokens: 900,
    uncachedInputTokens: 200,
    cacheCreationInputTokens: 300,
    cacheReadInputTokens: 400,
    outputTokens: 50,
  });
});

test("Claude usage records a cache-only request", () => {
  const readClaudeUsageTokens = usageReader();
  assert.deepEqual(readClaudeUsageTokens({
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2_048,
      output_tokens: 0,
    },
  }), {
    inputTokens: 2_048,
    uncachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 2_048,
    outputTokens: 0,
  });
});
