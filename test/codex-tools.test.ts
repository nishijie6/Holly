import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentEventQueue } from "../agent-events.js";
import { ConversationLedger } from "../conversation-ledger.js";
import type { LlmToolDefinition, LlmToolUseBlock } from "../llm-client.js";

// Import from a temporary working directory so transport tests never read or
// overwrite real project credentials.
const dir = await mkdtemp(join(tmpdir(), "holly-codex-tools-"));
const originalCwd = process.cwd();
await mkdir(join(dir, ".codex"));
await writeFile(join(dir, ".codex", "auth.json"), JSON.stringify({ tokens: {
  access_token: "test-access", account_id: "test-account",
} }));
process.chdir(dir);
const llm = await import("../llm-client.js");
process.chdir(originalCwd);
const { createLlmClient, splitSystemPrompt } = llm;
test.after(() => rm(dir, { recursive: true, force: true }));
const configPath = join(dir, "config.yaml");
await writeFile(configPath, `llm:
  active: gpt_main
  system_prompt: sys
  profiles:
    gpt_main:
      provider: codex
      model: gpt-5.4
`);
const WEATHER: LlmToolDefinition = {
  name: "get_weather", description: "Weather for a city.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
function response(output: Record<string, unknown>[], inputTokens = 10): Record<string, unknown> {
  return { id: "resp_test", object: "response", status: "completed", output,
    usage: { input_tokens: inputTokens, input_tokens_details: { cached_tokens: 4 }, output_tokens: 3 } };
}
const call = (id = "call_1", name = "get_weather", args = '{"city":"Paris"}') => ({
  type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: args, status: "completed",
});
const message = (text: string) => ({
  type: "message", id: "msg_1", role: "assistant", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

test("Responses cache writes remain separate from ordinary uncached input", () => {
  // Official prompt-caching usage example: the reused 12k prefix and newly
  // written 3k suffix together account for all 15k input tokens.
  assert.deepEqual(llm.readCodexUsageTokens({ usage: {
    input_tokens: 15_000,
    input_tokens_details: { cached_tokens: 12_000, cache_write_tokens: 3_000 },
    output_tokens: 20,
  } }), {
    inputTokens: 15_000,
    uncachedInputTokens: 0,
    cacheCreationInputTokens: 3_000,
    cacheReadInputTokens: 12_000,
    outputTokens: 20,
  });
});

test("Responses cache writes cannot double-count tokens already read from cache", () => {
  assert.deepEqual(llm.readCodexUsageTokens({ usage: {
    input_tokens: 1_000,
    input_tokens_details: { cached_tokens: 800, cache_write_tokens: 500 },
    output_tokens: 20,
  } }), {
    inputTokens: 1_000,
    uncachedInputTokens: 0,
    cacheCreationInputTokens: 200,
    cacheReadInputTokens: 800,
    outputTokens: 20,
  });
});

test("Responses usage keeps older or invalid cache-write details compatible", () => {
  for (const details of [
    { cached_tokens: 800 },
    { cached_tokens: 800, cache_write_tokens: -1 },
    { cached_tokens: 800, cache_write_tokens: "200" },
    { cached_tokens: 800, cache_write_tokens: Number.NaN },
    { cached_tokens: 800, cache_write_tokens: Number.POSITIVE_INFINITY },
  ]) {
    assert.deepEqual(llm.readCodexUsageTokens({ usage: {
      input_tokens: 1_000, input_tokens_details: details, output_tokens: 20,
    } }), {
      inputTokens: 1_000,
      uncachedInputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 800,
      outputTokens: 20,
    });
  }
});

function stubFetch(
  responses: Record<string, unknown>[],
  requests: Record<string, unknown>[] = [],
  usageHeaders: Record<string, string> = {
    "x-codex-primary-window-minutes": "300", "x-codex-primary-used-percent": "25",
    "x-codex-primary-reset-at": "1800000000", "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-used-percent": "10",
  },
): () => void {
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (url, init) => {
    assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-access");
    requests.push(JSON.parse(String(init?.body)));
    const body = responses[Math.min(index++, responses.length - 1)];
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: body })}\n\ndata: [DONE]\n\n`, {
      headers: { "Content-Type": "text/event-stream", ...usageHeaders },
    });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
async function run(client: Awaited<ReturnType<typeof createLlmClient>>, overrides: Record<string, unknown> = {}) {
  return client.runToolLoop({ messages: [{ role: "user", content: "weather?" }], tools: [WEATHER],
    runTool: async () => "18C", purpose: "focus-loop", cacheRoute: "focus-ledger", ...overrides });
}

test("GPT tool loop executes function calls and sends their outputs before completing", async () => {
  const requests: Record<string, unknown>[] = [];
  const restore = stubFetch([response([message("checking"), call()]), response([message("18C in Paris")], 12)], requests);
  try {
    const executed: LlmToolUseBlock[] = [];
    const client = await createLlmClient(configPath);
    const result = await run(client, { runTool: async (use: LlmToolUseBlock) => { executed.push(use); return "18C"; } });
    assert.deepEqual(executed, [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } }]);
    assert.equal(result.text, "18C in Paris");
    assert.equal(result.rounds, 2);
    assert.equal(result.exhausted, false);
    assert.deepEqual((requests[1].input as unknown[]).at(-1), { type: "function_call_output", call_id: "call_1", output: "18C" });
    assert.equal(result.messages.length, 4);
    assert.equal(result.messages[3].content, "18C in Paris");
    const usage = client.drainTokenUsage();
    assert.deepEqual(usage.map(u => [u.inputTokens, u.uncachedInputTokens, u.cacheReadInputTokens, u.outputTokens]), [[10, 6, 4, 3], [12, 8, 4, 3]]);
    assert.deepEqual(usage.map(u => u.purpose), ["focus-loop", "focus-loop"]);
    assert.deepEqual(client.drainTokenUsage(), []);
  } finally { restore(); }
});

test("stateless GPT loop resends encrypted reasoning and original output items in order", async () => {
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted-test" };
  const output = [reasoning, message("checking"), call()];
  const requests: Record<string, unknown>[] = [];
  const restore = stubFetch([response(output), response([message("done")])], requests);
  try {
    const turns: unknown[][] = [];
    const result = await run(await createLlmClient(configPath), { onAssistantTurn: (...args: unknown[]) => turns.push(args) });
    assert.deepEqual(requests[0].include, ["reasoning.encrypted_content"]);
    assert.equal(requests[0].store, false);
    assert.deepEqual((requests[1].input as unknown[]).slice(1, 4), output);
    assert.deepEqual((result.messages[1] as { responseItems?: unknown[] }).responseItems, output);
    assert.deepEqual(turns[0][2], output);
    const saved = splitSystemPrompt(result.messages, "sys").contents;
    const builder = (llm as unknown as Record<string, Function>).buildCodexRequestBody;
    assert.equal(typeof builder, "function");
    assert.deepEqual((builder("gpt-5.4", "sys", saved).input as unknown[]).slice(1, 4), output);
  } finally { restore(); }
});

test("parallel function calls receive every result in one ledger turn", async () => {
  const restore = stubFetch([response([call("call_1"), call("call_2")]), response([message("done")])]);
  try {
    const result = await run(await createLlmClient(configPath));
    assert.deepEqual(result.messages[2].blocks?.map(block => block.type === "tool_result" ? block.toolUseId : "bad"), ["call_1", "call_2"]);
  } finally { restore(); }
});

test("background work yields to incoming chat after settling all current tool calls", async () => {
  const requests: Record<string, unknown>[] = [];
  const restore = stubFetch([response([call("call_1"), call("call_2")])], requests);
  try {
    const queue = new AgentEventQueue();
    const ledger = new ConversationLedger();
    ledger.appendUserText("read something while idle");
    let unread = false;
    const executed: string[] = [];
    const result = await run(await createLlmClient(configPath), {
      messages: [...ledger.snapshot()],
      maxRounds: 8,
      shouldYield: () => unread,
      runTool: async (use: LlmToolUseBlock) => {
        executed.push(use.id);
        if (!unread) {
          unread = true;
          queue.push({ type: "message_batch_ready", groupKey: "test-group" });
        }
        return "page read";
      },
      onAssistantTurn: (...args: Parameters<ConversationLedger["appendAssistantTurn"]>) => ledger.appendAssistantTurn(...args),
      onToolResults: (...args: Parameters<ConversationLedger["appendToolResults"]>) => ledger.appendToolResults(...args),
    });
    assert.equal(requests.length, 1, "new chat must not wait for all eight background rounds");
    assert.deepEqual(executed, ["call_1", "call_2"], "yield only after every tool result is collected");
    assert.equal(result.rounds, 1);
    assert.equal(result.exhausted, false);
    assert.equal(result.yielded, true);
    assert.deepEqual([...ledger.pendingToolUses], []);
    assert.deepEqual(queue.takeAll(), [{ type: "message_batch_ready", groupKey: "test-group" }]);
    ledger.appendUserText("找找最近 git 上热点项目");
    assert.equal(ledger.snapshot().at(-1)?.content, "找找最近 git 上热点项目");
  } finally { restore(); }
});

test("background work can yield before its first request without spending model tokens", async () => {
  const requests: Record<string, unknown>[] = [];
  const restore = stubFetch([response([message("should not be requested")])], requests);
  try {
    const result = await run(await createLlmClient(configPath), { shouldYield: () => true });
    assert.equal(requests.length, 0);
    assert.equal(result.rounds, 0);
    assert.equal(result.exhausted, false);
    assert.equal(result.yielded, true);
    assert.equal(result.messages.length, 1);
  } finally { restore(); }
});

for (const [name, item, error] of [
  ["throwing tool", call(), /tool exploded/],
  ["unknown tool", call("call_1", "unknown"), /unknown.*tool/i],
  ["malformed JSON arguments", call("call_1", "get_weather", "{bad"), /invalid.*arguments/i],
  ["non-object arguments", call("call_1", "get_weather", "[]"), /invalid.*arguments/i],
] as const) {
  test(`${name} produces an error result with the original call ID`, async () => {
    const requests: Record<string, unknown>[] = [];
    const restore = stubFetch([response([item]), response([message("handled")])], requests);
    try {
      let executed = 0;
      const result = await run(await createLlmClient(configPath), { runTool: async () => { executed++; throw new Error("tool exploded"); } });
      assert.equal(executed, name === "throwing tool" ? 1 : 0);
      const block = result.messages[2].blocks?.[0];
      assert.equal(block?.type, "tool_result");
      if (block?.type !== "tool_result") return;
      assert.equal(block.toolUseId, "call_1");
      assert.equal(block.isError, true);
      assert.match(block.content, error);
      const wire = (requests[1].input as Record<string, unknown>[]).at(-1)!;
      assert.equal(wire.call_id, "call_1");
      assert.match(String(wire.output), error);
    } finally { restore(); }
  });
}

test("round ceiling returns an exhausted partial transcript", async () => {
  const restore = stubFetch([response([call()])]);
  try {
    let executed = 0;
    const result = await run(await createLlmClient(configPath), { maxRounds: 3, runTool: async () => { executed++; return "again"; } });
    assert.equal(result.exhausted, true);
    assert.equal(result.rounds, 3);
    assert.equal(executed, 3);
    assert.equal(result.messages.at(-1)?.blocks?.[0].type, "tool_result");
  } finally { restore(); }
});

test("cache observer excuses only the first round and uses the configured route", async () => {
  const restore = stubFetch([response([call()]), response([message("done")])]);
  try {
    const observed: Array<{ expectRebuild: boolean; status: string }> = [];
    const client = await createLlmClient(configPath, undefined, { cachePrefixObserver: event => observed.push(event) });
    await run(client, { expectRebuild: true });
    assert.deepEqual(observed.map(event => event.expectRebuild), [true, false]);
    assert.deepEqual(observed.map(event => event.status), ["fresh", "extended"]);
  } finally { restore(); }
});

test("GPT-6.1 Sol text and every tool round explicitly request maximum reasoning", async () => {
  const maxConfigPath = join(dir, "max-reasoning.yaml");
  await writeFile(maxConfigPath, `llm:
  active: gpt_main
  decision_profile: gpt_decision
  profiles:
    gpt_main:
      provider: codex
      model: gpt-6.1-sol
    gpt_decision:
      provider: codex
      model: gpt-6.1-sol
`);
  const requests: Record<string, unknown>[] = [];
  const restore = stubFetch([response([message("hello")]), response([call()]), response([message("done")])], requests);
  try {
    const main = await createLlmClient(maxConfigPath);
    const decision = await createLlmClient(maxConfigPath, "gpt_decision");
    assert.equal(await main.generateText({ messages: [{ role: "user", content: "hello" }], purpose: "eval-script", cacheRoute: "max-text" }), "hello");
    assert.equal((await run(decision)).text, "done");
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.model, "gpt-6.1-sol");
      assert.deepEqual(request.reasoning, { effort: "max" });
    }
  } finally { restore(); }
});

test("compaction can use lower reasoning without changing later conversation calls", async () => {
  const compactConfig = join(dir, "compaction-reasoning.yaml");
  await writeFile(compactConfig, "llm:\n  active: main\n  profiles:\n    main:\n      provider: codex\n      model: gpt-6.1-sol\n");
  const requests: Record<string, unknown>[] = [];
  const restore = stubFetch([response([message("summary")]), response([message("hello")])], requests);
  try {
    const client = await createLlmClient(compactConfig);
    await run(client, { purpose: "ledger-compaction", cacheRoute: "ledger-compaction", reasoningEffort: "low" });
    await run(client);
    assert.deepEqual(requests[0].reasoning, { effort: "low" });
    assert.deepEqual(requests[1].reasoning, { effort: "max" });
  } finally { restore(); }
});

test("a one-attempt compaction timeout yields immediately instead of retrying in the focus queue", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    if (++requests === 1) throw new DOMException("summary timed out", "TimeoutError");
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: response([message("retried")]) })}\n\n`);
  }) as typeof fetch;
  try {
    await assert.rejects(run(await createLlmClient(configPath), { maxAttempts: 1 }), { name: "TimeoutError" });
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});

test("Codex retains one session identity across tool rounds and later calls on the same cache route", async () => {
  const requests: Record<string, unknown>[] = [];
  const restore = stubFetch([response([call()]), response([message("done")]), response([message("later")]), response([message("other")])], requests);
  const transport = globalThis.fetch;
  const sessions: Array<string | null> = [];
  globalThis.fetch = (async (url, init) => {
    sessions.push(new Headers(init?.headers).get("session_id"));
    return transport(url, init);
  }) as typeof fetch;
  try {
    const client = await createLlmClient(configPath);
    assert.equal((await run(client, { cacheRoute: "cache-session-test" })).text, "done");
    assert.equal(await client.generateText({ messages: [{ role: "user", content: "later" }], purpose: "eval-script", cacheRoute: "cache-session-test" }), "later");
    assert.equal(await client.generateText({ messages: [{ role: "user", content: "other" }], purpose: "eval-script", cacheRoute: "other-cache-session-test" }), "other");
    assert.equal(sessions.length, 4);
    assert.match(sessions[0] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(sessions[1], sessions[0]);
    assert.equal(sessions[2], sessions[0]);
    assert.notEqual(sessions[3], sessions[0]);
  } finally { restore(); }
});

test("structured text generation sends the JSON schema on the Codex request", async () => {
  const requests: Record<string, unknown>[] = [];
  const restore = stubFetch([response([message('{"ok":true}')])], requests);
  try {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
    const client = await createLlmClient(configPath);
    const text = await client.generateText({ messages: [{ role: "user", content: "decide" }], jsonSchema: schema, purpose: "decision", cacheRoute: "decision:123" });
    assert.equal(text, '{"ok":true}');
    assert.deepEqual(requests[0].text, { format: { type: "json_schema", name: "holly_response", strict: true, schema } });
    assert.match(String(requests[0].prompt_cache_key), /decision:123$/);
    assert.deepEqual(requests[0].tools, undefined);
    assert.deepEqual(llm.getLatestProviderUsage()?.windows, [
      { id: "primary", windowDurationMins: 300, utilization: .25, resetAt: 1800000000000, status: "allowed" },
      { id: "secondary", windowDurationMins: 10080, utilization: .1, resetAt: null, status: "allowed" },
    ]);
  } finally { restore(); }
});

for (const [name, headers, expected] of [
  ["a weekly primary window with no secondary", {
    "x-codex-primary-window-minutes": "10080", "x-codex-primary-used-percent": "17",
    "x-codex-primary-reset-at": "1792295875",
  }, [
    { id: "primary", windowDurationMins: 10080, utilization: .17, resetAt: 1792295875000, status: "allowed" },
  ]],
  ["a disabled zero-duration secondary window", {
    "x-codex-primary-window-minutes": "10080", "x-codex-primary-used-percent": "17",
    "x-codex-primary-reset-at": "1792295875", "x-codex-secondary-window-minutes": "0",
    "x-codex-secondary-used-percent": "0", "x-codex-secondary-reset-at": "",
  }, [
    { id: "primary", windowDurationMins: 10080, utilization: .17, resetAt: 1792295875000, status: "allowed" },
  ]],
  ["an unfamiliar window duration", {
    "x-codex-primary-window-minutes": "1440", "x-codex-primary-used-percent": "25",
  }, [
    { id: "primary", windowDurationMins: 1440, utilization: .25, resetAt: null, status: "allowed" },
  ]],
  ["a missing window duration", {
    "x-codex-primary-used-percent": "25",
  }, [
    { id: "primary", windowDurationMins: null, utilization: .25, resetAt: null, status: "allowed" },
  ]],
  ["missing utilization alongside an actual zero percent", {
    "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": "1800000000",
    "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-used-percent": "0",
  }, [
    { id: "primary", windowDurationMins: 300, utilization: null, resetAt: 1800000000000, status: null },
    { id: "secondary", windowDurationMins: 10080, utilization: 0, resetAt: null, status: "allowed" },
  ]],
  ["negative utilization and reset headers", {
    "x-codex-primary-window-minutes": "300", "x-codex-primary-used-percent": "-1",
    "x-codex-primary-reset-at": "-10",
  }, [
    { id: "primary", windowDurationMins: 300, utilization: null, resetAt: null, status: null },
  ]],
  ["negative duration and nonfinite reset headers", {
    "x-codex-primary-window-minutes": "-300", "x-codex-primary-used-percent": "125",
    "x-codex-primary-reset-at": "Infinity",
  }, [
    { id: "primary", windowDurationMins: null, utilization: 1.25, resetAt: null, status: "limited" },
  ]],
  ["empty duration and invalid utilization headers", {
    "x-codex-primary-window-minutes": " ", "x-codex-primary-used-percent": "NaN",
    "x-codex-primary-reset-at": "1800000000",
  }, [
    { id: "primary", windowDurationMins: null, utilization: null, resetAt: 1800000000000, status: null },
  ]],
] as const) {
  test(`quota capture preserves ${name}`, async () => {
    const restore = stubFetch([response([message("done")])], [], headers);
    try {
      const startedAt = Date.now();
      await run(await createLlmClient(configPath));
      const usage = llm.getLatestProviderUsage();
      assert.deepEqual(usage?.windows, expected);
      assert.ok(usage && usage.capturedAt >= startedAt && usage.capturedAt <= Date.now());
    } finally { restore(); }
  });
}

test("responses with no quota headers retain the latest captured windows", async () => {
  let restore = stubFetch([response([message("done")])]);
  let captured;
  try {
    await run(await createLlmClient(configPath));
    captured = llm.getLatestProviderUsage();
  } finally { restore(); }
  restore = stubFetch([response([message("done")])], [], {});
  try {
    await run(await createLlmClient(configPath));
    assert.equal(llm.getLatestProviderUsage(), captured);
  } finally { restore(); }
});

test("explicitly disabling every quota window clears earlier active windows", async () => {
  let restore = stubFetch([response([message("done")])]);
  let captured;
  try {
    await run(await createLlmClient(configPath));
    captured = llm.getLatestProviderUsage();
    assert.equal(captured?.windows.length, 2);
  } finally { restore(); }
  restore = stubFetch([response([message("done")])], [], {
    "x-codex-primary-window-minutes": "0", "x-codex-primary-used-percent": "0",
    "x-codex-secondary-window-minutes": "0", "x-codex-secondary-used-percent": "0",
  });
  try {
    await run(await createLlmClient(configPath));
    const usage = llm.getLatestProviderUsage();
    assert.deepEqual(usage?.windows, []);
    assert.notEqual(usage, captured);
  } finally { restore(); }
});

test("splitSystemPrompt keeps a tool_result turn whose only content is blocks", () => {
  const results = [{ type: "tool_result", toolUseId: "t1", content: "晴" }] as const;
  const { contents } = splitSystemPrompt(
    [{ role: "user", content: "", blocks: [...results] as never }],
    "persona",
  );
  assert.equal(contents.length, 1, "tool_result 回合不能因为 content 为空就被丢弃");
  assert.deepEqual(contents[0].blocks, [...results]);
});

test("splitSystemPrompt keeps the tool_use blocks of an assistant turn that also has prose", () => {
  const uses = [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "北京" } }] as const;
  const { contents } = splitSystemPrompt(
    [{ role: "assistant", content: "我查一下", blocks: [...uses] as never }],
    "persona",
  );
  assert.equal(contents[0].content, "我查一下");
  assert.deepEqual(contents[0].blocks, [...uses], "blocks 必须原样带过去，否则工具轨迹就断了");
});

test("splitSystemPrompt still drops a turn with neither prose nor blocks", () => {
  const { contents } = splitSystemPrompt([{ role: "user", content: "   " }], "persona");
  assert.deepEqual(contents, []);
});

test("splitSystemPrompt still hoists system turns into the prompt", () => {
  const { systemPrompt, contents } = splitSystemPrompt(
    [{ role: "system", content: "额外规则" }, { role: "user", content: "你好" }],
    "persona",
  );
  assert.equal(systemPrompt, "persona\n\n额外规则");
  assert.deepEqual(contents, [{ role: "user", content: "你好" }]);
});

// 真正会回归的那条：一轮工具循环结束后的记录，再喂回 splitSystemPrompt，
// 必须还原成同一份结构——否则下一次调用的缓存前缀和上一次对不上。
test("a tool transcript survives a round-trip through splitSystemPrompt unchanged", () => {
  const transcript = [
    { role: "user" as const, content: "北京天气?" },
    {
      role: "assistant" as const,
      content: "",
      blocks: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "北京" } }] as never,
    },
    {
      role: "user" as const,
      content: "",
      blocks: [{ type: "tool_result", toolUseId: "t1", content: "晴" }] as never,
    },
  ];
  const { contents } = splitSystemPrompt(transcript, "persona");
  assert.deepEqual(contents, transcript);
});

function streamedEvents(events: Record<string, unknown>[], trailingNewline = false): Response {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("").trimEnd() + (trailingNewline ? "\n\n" : ""));
  // Split both UTF-8 characters and SSE lines across network reads.
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset += 7));
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

test("streamed argument deltas become one complete call without duplicate output items", async () => {
  const original = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted-done" };
  let index = 0;
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (index++ > 0) return streamedEvents([
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "北京" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "北京晴天" },
      { type: "response.output_item.done", output_index: 0, item: message("北京晴天") },
      { type: "response.completed", response: response([message("北京晴天")]) },
    ]);
    return streamedEvents([
      { type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: "partial" } },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_item.added", output_index: 1, item: { ...call(), arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_call_1", delta: '{"city":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_call_1", delta: '"北京"}' },
      { type: "response.function_call_arguments.done", item_id: "fc_call_1", arguments: '{"city":"北京"}' },
      { type: "response.output_item.done", output_index: 1, item: call("call_1", "get_weather", '{"city":"北京"}') },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 8, output_tokens: 2 } } },
    ]);
  }) as typeof fetch;
  try {
    const executed: unknown[] = [];
    const client = await createLlmClient(configPath);
    const result = await run(client, { runTool: async (use: LlmToolUseBlock) => { executed.push(use.input); return "晴天"; } });
    assert.deepEqual(executed, [{ city: "北京" }]);
    assert.equal(result.text, "北京晴天");
    assert.deepEqual((requests[1].input as unknown[]).slice(1, 3), [reasoning, call("call_1", "get_weather", '{"city":"北京"}')]);
    assert.equal(client.drainTokenUsage().length, 2);
  } finally { globalThis.fetch = original; }
});

for (const events of [
  [{ type: "response.output_text.delta", delta: "unfinished" }],
  [{ type: "response.failed", response: { status: "failed", error: { message: "server failed" } } }],
  [{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }],
]) {
  test(`a ${String(events[0].type)} stream cannot be returned as a completed answer`, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => streamedEvents(events)) as typeof fetch;
    try {
      const client = await createLlmClient(configPath);
      await assert.rejects(() => run(client), /before completion|response failed|response incomplete/i);
      assert.deepEqual(client.drainTokenUsage(), []);
    } finally { globalThis.fetch = original; }
  });
}

test("a dropped response body is retried before any tool executes", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  let executions = 0;
  globalThis.fetch = (async () => {
    if (++requests === 1) return new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("fetch failed")); },
    }), { headers: { "Content-Type": "text/event-stream" } });
    return streamedEvents([{ type: "response.completed", response: response([message("recovered")]) }]);
  }) as typeof fetch;
  try {
    const result = await run(await createLlmClient(configPath), { runTool: async () => { executions++; return "ok"; } });
    assert.equal(result.text, "recovered");
    assert.equal(requests, 2);
    assert.equal(executions, 0);
  } finally { globalThis.fetch = original; }
});

test("an undici terminated stream with ECONNRESET is retried", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  const terminated = new TypeError("terminated", { cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }) });
  globalThis.fetch = (async () => {
    if (++requests === 1) return new Response(new ReadableStream({
      start(controller) { controller.error(terminated); },
    }), { headers: { "Content-Type": "text/event-stream" } });
    return streamedEvents([{ type: "response.completed", response: response([message("recovered")]) }]);
  }) as typeof fetch;
  try {
    const result = await run(await createLlmClient(configPath));
    assert.equal(result.text, "recovered");
    assert.equal(requests, 2);
  } finally { globalThis.fetch = original; }
});

test("a fetch aborted by the request timeout is retried", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    if (++requests === 1) throw new DOMException("The operation was aborted", "AbortError");
    return streamedEvents([{ type: "response.completed", response: response([message("recovered")]) }]);
  }) as typeof fetch;
  try {
    const result = await run(await createLlmClient(configPath));
    assert.equal(result.text, "recovered");
    assert.equal(requests, 2);
  } finally { globalThis.fetch = original; }
});

test("a rejected access token is refreshed once and the response uses the new credentials", async () => {
  const authPath = join(dir, ".codex", "auth.json");
  await writeFile(authPath, JSON.stringify({ tokens: { access_token: "test-access", refresh_token: "test-refresh", account_id: "test-account" } }));
  const original = globalThis.fetch;
  const authHeaders: string[] = [];
  let refreshes = 0;
  globalThis.fetch = (async (url, init) => {
    if (url === "https://auth.openai.com/oauth/token") {
      refreshes++;
      assert.deepEqual(JSON.parse(String(init?.body)), { grant_type: "refresh_token", refresh_token: "test-refresh", client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
      return new Response(JSON.stringify({ access_token: "test-renewed", refresh_token: "test-next", expires_in: 3600 }), { headers: { "Content-Type": "application/json" } });
    }
    const authorization = new Headers(init?.headers).get("Authorization")!;
    authHeaders.push(authorization);
    if (authorization === "Bearer test-access") return new Response("expired", { status: 401 });
    return streamedEvents([{ type: "response.completed", response: response([message("renewed")]) }]);
  }) as typeof fetch;
  try {
    const client = await createLlmClient(configPath);
    const result = await run(client);
    assert.equal(result.text, "renewed");
    assert.equal(refreshes, 1);
    assert.deepEqual(authHeaders, ["Bearer test-access", "Bearer test-renewed"]);
    assert.equal(client.drainTokenUsage().length, 1);
  } finally {
    globalThis.fetch = original;
    await writeFile(authPath, JSON.stringify({ tokens: { access_token: "test-access", account_id: "test-account" } }));
  }
});

test("describeTransportError retains the socket cause and code", () => {
  const error = new TypeError("fetch failed", { cause: Object.assign(new Error("TLS disconnected"), { code: "ECONNRESET" }) });
  const described = llm.describeTransportError(error);
  assert.match(described, /fetch failed/);
  assert.match(described, /TLS disconnected/);
  assert.match(described, /code=ECONNRESET/);
  assert.equal(llm.describeTransportError("plain string"), "plain string");
});

for (const variant of ["exhausted-secondary", "malformed-secondary", "unknown", "unrecognized", "network-failure"] as const) {
  test(`quota refresh keeps generation paused for ${variant}`, async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    const resetAt = Math.floor(now / 1000) + 7 * 24 * 3600;
    let modelRequests = 0;
    let usageRequests = 0;
    let cleanup = false;
    const client = await createLlmClient(configPath);
    globalThis.fetch = (async (url) => {
      if (url === "https://chatgpt.com/backend-api/wham/usage") {
        usageRequests++;
        if (variant === "network-failure") throw new TypeError("quota fetch failed");
        const data = variant === "unrecognized" ? {} : { rate_limit: variant === "malformed-secondary"
          ? { primary_window: { limit_window_seconds: 604800, used_percent: 5, reset_at: resetAt }, secondary_window: "malformed" }
          : variant === "unknown"
          ? { primary_window: { used_percent: null } }
          : { allowed: false, limit_reached: true,
            primary_window: { limit_window_seconds: 604800, used_percent: 4, reset_at: resetAt },
            secondary_window: { limit_window_seconds: 18000, used_percent: 100, reset_at: resetAt - 1000 },
          } };
        return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
      }
      assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
      modelRequests++;
      return cleanup
        ? new Response(JSON.stringify(response([message("cleanup")])), { headers: { "Content-Type": "application/json" } })
        : new Response("limited", { status: 429, headers: {
          "x-codex-primary-window-minutes": "10080", "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": String(resetAt),
        } });
    }) as typeof fetch;
    try {
      await assert.rejects(run(client), /Codex API error 429/);
      if (variant === "network-failure" || variant === "unrecognized") await assert.rejects(llm.probeProviderUsage(client.model));
      else await llm.probeProviderUsage(client.model);
      await assert.rejects(run(client), /requests are paused/);
      assert.equal(usageRequests, 1, "do not immediately repeat a failed or denied quota check");
      assert.equal(modelRequests, 1, "never probe model generation when quota is still unknown or exhausted");
    } finally {
      cleanup = true;
      now += 14 * 24 * 3600_000;
      await run(client).catch(() => {});
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
    }
  });
}

for (const manual of [true, false]) {
  test(`${manual ? "manual usage refresh" : "automatic quota recheck"} reads real quota and releases an obsolete pause without a model probe`, async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    const resetAt = Math.floor(now / 1000) + 7 * 24 * 3600;
    let limited = true;
    let modelRequests = 0;
    let usageRequests = 0;
    const client = await createLlmClient(configPath);
    globalThis.fetch = (async (url, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-access");
      if (url === "https://chatgpt.com/backend-api/wham/usage") {
        usageRequests++;
        assert.ok(!init?.method || init.method === "GET");
        return new Response(JSON.stringify({ rate_limit: {
          allowed: true, limit_reached: false,
          primary_window: { limit_window_seconds: 604800, used_percent: 4, reset_at: resetAt + 1000 },
          secondary_window: null,
        } }), { headers: { "Content-Type": "application/json" } });
      }
      assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
      modelRequests++;
      return limited
        ? new Response("limited", { status: 429, headers: {
          "x-codex-primary-window-minutes": "10080", "x-codex-primary-used-percent": "100",
          "x-codex-primary-reset-at": String(resetAt),
        } })
        : new Response(JSON.stringify(response([message("resumed")])), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      await assert.rejects(run(client), /Codex API error 429/);
      limited = false;
      if (manual) {
        const usage = await llm.probeProviderUsage(client.model);
        assert.equal(usageRequests, 1, "refresh must query the usage endpoint even while generation is paused");
        assert.equal(usage?.windows[0].utilization, 0.04);
        assert.equal(usage?.windows[0].windowDurationMins, 10080);
        assert.equal(modelRequests, 1, "quota refresh must not generate a ping response");
      } else {
        await assert.rejects(run(client), /requests are paused/);
        assert.equal(usageRequests, 0);
        now += 5 * 60_000;
      }
      assert.equal((await run(client)).text, "resumed");
      assert.equal(usageRequests, 1);
      assert.equal(modelRequests, 2);
    } finally {
      limited = false;
      now += 14 * 24 * 3600_000;
      await run(client).catch(() => {});
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
    }
  });
}

test("429 usage headers survive the error and pause subsequent requests", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  const resetAt = Math.floor(Date.now() / 1000) + 600;
  globalThis.fetch = (async () => {
    requests++;
    return new Response("limited", { status: 429, headers: {
      "x-codex-primary-window-minutes": "10080", "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(resetAt), "x-codex-secondary-window-minutes": "0",
      "x-codex-secondary-used-percent": "0",
    } });
  }) as typeof fetch;
  try {
    const client = await createLlmClient(configPath);
    await assert.rejects(() => run(client), /Codex API error 429/);
    assert.deepEqual(llm.getLatestProviderUsage()?.windows, [
      { id: "primary", windowDurationMins: 10080, utilization: 1, resetAt: resetAt * 1000, status: "limited" },
    ]);
    await assert.rejects(() => run(client), /requests are paused/);
    assert.equal(requests, 1);
    assert.deepEqual(client.drainTokenUsage(), []);
  } finally { globalThis.fetch = original; }
});
