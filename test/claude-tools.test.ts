import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildClaudeRequestBody,
  createLlmClient,
  digestClaudeCachedPrefix,
  parseClaudeToolUses,
  runClaudeToolLoop,
  splitSystemPrompt,
} from "../llm-client.js";
import type { LlmToolDefinition, LlmToolUseBlock } from "../llm-client.js";
import type { TokenUsageBreakdown } from "../token-usage.js";

// Tool calling over Holly's own OAuth transport. The invariants pinned here are
// the ones whose violation is a 400 from the API rather than a worse answer:
// a tool_use with no matching tool_result, results split across turns, or an
// assistant tool turn trimmed away as if it were prefill.

const WEATHER: LlmToolDefinition = {
  name: "get_weather",
  description: "Weather for a city.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

function contentOf(body: Record<string, unknown>, index: number): Array<Record<string, unknown>> {
  const messages = body.messages as Array<Record<string, unknown>>;
  return messages[index].content as Array<Record<string, unknown>>;
}

// --- request body ----------------------------------------------------------

test("tools are sent with the API's snake_case input_schema", () => {
  const body = buildClaudeRequestBody("claude-sonnet-4-6", "sys", [{ role: "user", content: "hi" }], {
    tools: [WEATHER],
  });
  assert.deepEqual(body.tools, [
    { name: "get_weather", description: "Weather for a city.", input_schema: WEATHER.inputSchema },
  ]);
});

test("no tools key when the caller passes none, so existing requests are unchanged", () => {
  const body = buildClaudeRequestBody("claude-sonnet-4-6", "sys", [{ role: "user", content: "hi" }], {});
  assert.equal("tools" in body, false);
});

test("a tool_use turn serializes prose first, then its calls", () => {
  const body = buildClaudeRequestBody("claude-sonnet-4-6", "sys", [
    { role: "user", content: "weather?" },
    {
      role: "assistant",
      content: "checking",
      blocks: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } }],
    },
    { role: "user", content: "", blocks: [{ type: "tool_result", toolUseId: "tu_1", content: "18C" }] },
  ], {});

  assert.deepEqual(contentOf(body, 1), [
    { type: "text", text: "checking" },
    { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } },
  ]);
  assert.deepEqual(contentOf(body, 2), [
    { type: "tool_result", tool_use_id: "tu_1", content: "18C" },
  ]);
});

test("a failed tool result carries is_error", () => {
  const body = buildClaudeRequestBody("claude-sonnet-4-6", "sys", [
    { role: "user", content: "weather?" },
    { role: "assistant", content: "", blocks: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: {} }] },
    {
      role: "user",
      content: "",
      blocks: [{ type: "tool_result", toolUseId: "tu_1", content: "boom", isError: true }],
    },
  ], {});
  assert.deepEqual(contentOf(body, 2), [
    { type: "tool_result", tool_use_id: "tu_1", content: "boom", is_error: true },
  ]);
});

test("a trailing assistant tool turn survives the prefill trim", () => {
  // The text-only path drops a trailing assistant turn (OAuth models reject
  // prefill). Doing that to a tool turn would orphan its tool_use id instead.
  const body = buildClaudeRequestBody("claude-sonnet-4-6", "sys", [
    { role: "user", content: "weather?" },
    { role: "assistant", content: "", blocks: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: {} }] },
  ], {});
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, "assistant");
});

test("a trailing assistant text turn is still trimmed", () => {
  const body = buildClaudeRequestBody("claude-sonnet-4-6", "sys", [
    { role: "user", content: "hi" },
    { role: "assistant", content: "bye" },
  ], {});
  assert.equal((body.messages as unknown[]).length, 1);
});

test("structural turns never merge into a neighbour of the same role", () => {
  const body = buildClaudeRequestBody("claude-sonnet-4-6", "sys", [
    { role: "user", content: "weather?" },
    { role: "assistant", content: "", blocks: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: {} }] },
    { role: "user", content: "", blocks: [{ type: "tool_result", toolUseId: "tu_1", content: "18C" }] },
    { role: "user", content: "and tomorrow?" },
  ], {});
  const messages = body.messages as Array<Record<string, unknown>>;
  // Merging the tool_result turn with the follow-up question would put the
  // question inside the same turn as the result and reorder the pairing.
  assert.equal(messages.length, 4);
});

// --- prefix digest ---------------------------------------------------------

test("two different tool calls do not digest as identical", () => {
  const withCall = (city: string) => buildClaudeRequestBody("claude-sonnet-4-6", "sys", [
    { role: "user", content: "weather?" },
    {
      role: "assistant",
      content: "",
      blocks: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city } }],
    },
    {
      role: "user",
      content: "",
      blocks: [{ type: "tool_result", toolUseId: "tu_1", content: city }],
    },
  ], { cacheStablePrefix: true, volatileTailMessages: 0 });

  const a = digestClaudeCachedPrefix(withCall("Paris"));
  const b = digestClaudeCachedPrefix(withCall("Tokyo"));
  // If tool blocks digested as "" these would match, and the drift detector
  // would call a rebuilt prefix unchanged.
  assert.notDeepEqual(a.blockDigests, b.blockDigests);
});

// --- parsing ---------------------------------------------------------------

test("parseClaudeToolUses picks tool_use blocks and ignores prose", () => {
  const uses = parseClaudeToolUses({
    content: [
      { type: "text", text: "let me check" },
      { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } },
    ],
  });
  assert.deepEqual(uses, [
    { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } },
  ]);
});

test("parseClaudeToolUses defaults a missing input to an empty object", () => {
  const uses = parseClaudeToolUses({ content: [{ type: "tool_use", id: "tu_1", name: "n" }] });
  assert.deepEqual(uses[0].input, {});
});

test("parseClaudeToolUses skips malformed blocks instead of throwing", () => {
  const uses = parseClaudeToolUses({
    content: [{ type: "tool_use", name: "no-id" }, { type: "tool_use", id: "tu_2", name: "ok", input: {} }, null],
  });
  assert.deepEqual(uses.map((u) => u.id), ["tu_2"]);
});

// --- the loop --------------------------------------------------------------

// runClaudeToolLoop goes through the real transport, so exercise it by stubbing
// global fetch: that keeps the auth/retry/usage path under test rather than
// mocked out, which is where the loop's real risk sits.
function stubFetch(responses: Array<Record<string, unknown>>): () => void {
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const noUsage = (_usage: TokenUsageBreakdown): void => {};

test("the loop runs a tool, feeds the result back, and stops at end_turn", async () => {
  const restore = stubFetch([
    {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "18C in Paris" }] },
  ]);
  try {
    const calls: string[] = [];
    const result = await runClaudeToolLoop({
      model: "claude-sonnet-4-6",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "weather?" }],
      tools: [WEATHER],
      runTool: async (call: LlmToolUseBlock) => { calls.push(call.name); return "18C"; },
      recordUsage: noUsage,
    });

    assert.deepEqual(calls, ["get_weather"]);
    assert.equal(result.text, "18C in Paris");
    assert.equal(result.rounds, 2);
    assert.equal(result.exhausted, false);
    // Grown, not rewritten: the original turn is still message 0.
    assert.equal(result.messages.length, 4);
    assert.equal(result.messages[0].content, "weather?");
    assert.equal(result.messages[1].blocks?.[0].type, "tool_use");
    assert.equal(result.messages[2].blocks?.[0].type, "tool_result");
    // 收尾那一轮不调工具，但她在这一轮说了查到的结果。以前这句话只进监控页、不进账本，
    // 下一轮她就看不到自己刚说过什么了；现在它是账本的最后一条，不带 blocks。
    assert.equal(result.messages[3].role, "assistant");
    assert.equal(result.messages[3].content, "18C in Paris");
    assert.equal(result.messages[3].blocks, undefined);
  } finally {
    restore();
  }
});

// 调用方按轮次解读前缀检查：只有第一轮的请求内容来自调用方，之后每一轮都只是在后面追加这次循环
// 自己的轮次，必须是延长（见 llm-client 里 runToolLoop 的 expectRebuild）。所以轮次编号要如实传出。
test("inspectBody is told which round each request belongs to", async () => {
  const restore = stubFetch([
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } }],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "18C in Paris" }] },
  ]);
  try {
    const rounds: number[] = [];
    await runClaudeToolLoop({
      model: "claude-sonnet-4-6",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "weather?" }],
      tools: [WEATHER],
      runTool: async () => "18C",
      recordUsage: noUsage,
      inspectBody: (_body, round) => { rounds.push(round); },
    });

    assert.deepEqual(rounds, [1, 2]);
  } finally {
    restore();
  }
});

// 真正改变行为的是客户端这一层：runToolLoop 只把 expectRebuild 交给第一轮。发过压缩请求的那一轮要
// 豁免第一次请求，但第二轮以后只是在后面追加，真出了漂移必须照常报 error，不能跟着被豁免。
test("runToolLoop excuses only its first round when the caller expects a rebuild", async () => {
  const dir = await mkdtemp(join(tmpdir(), "holly-tool-loop-"));
  const configPath = join(dir, "config.yaml");
  let restore = (): void => {};
  try {
    await writeFile(configPath, [
      "llm:",
      "  active: claude_sonnet",
      "  decision_profile: claude_sonnet",
      "  system_prompt: sys",
      "  profiles:",
      "    claude_sonnet:",
      "      provider: claude",
      "      model: claude-sonnet-4-6",
      "",
    ].join("\n"), "utf8");
    const excused: boolean[] = [];
    const client = await createLlmClient(configPath, undefined, {
      cachePrefixObserver: (event) => { excused.push(event.expectRebuild); },
    });
    // 客户端建好之后再换掉 fetch：模拟的响应只该被这次循环的两轮消耗。
    restore = stubFetch([
      {
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } }],
      },
      {
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 5 },
        content: [{ type: "text", text: "18C in Paris" }],
      },
    ]);

    await client.runToolLoop({
      messages: [{ role: "user", content: "weather?" }],
      tools: [WEATHER],
      runTool: async () => "18C",
      purpose: "focus-loop",
      cacheRoute: "focus-ledger",
      expectRebuild: true,
    });

    assert.deepEqual(excused, [true, false]);
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel calls produce one user turn holding every result", async () => {
  const restore = stubFetch([
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "get_weather", input: {} },
        { type: "tool_use", id: "tu_2", name: "get_time", input: {} },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
  ]);
  try {
    const result = await runClaudeToolLoop({
      model: "claude-sonnet-4-6",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "both?" }],
      tools: [WEATHER],
      runTool: async () => "ok",
      recordUsage: noUsage,
    });
    // 找工具结果那一轮，而不是取最后一条：收尾的纯文本轮如今也留在账本里，末尾已经不是它了。
    const resultTurn = result.messages.findLast(
      (message) => (message.blocks ?? []).some((block) => block.type === "tool_result"),
    );
    assert.equal(resultTurn?.role, "user");
    assert.equal(resultTurn?.blocks?.length, 2);
    assert.deepEqual(resultTurn?.blocks?.map((b) => (b as { toolUseId: string }).toolUseId), ["tu_1", "tu_2"]);
  } finally {
    restore();
  }
});

test("a throwing tool still answers its tool_use id, flagged as an error", async () => {
  const restore = stubFetch([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: {} }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "sorry" }] },
  ]);
  try {
    const result = await runClaudeToolLoop({
      model: "claude-sonnet-4-6",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "weather?" }],
      tools: [WEATHER],
      runTool: async () => { throw new Error("tool exploded"); },
      recordUsage: noUsage,
    });
    const resultTurn = result.messages.findLast(
      (message) => (message.blocks ?? []).some((block) => block.type === "tool_result"),
    );
    const block = resultTurn?.blocks?.[0] as { toolUseId: string; content: string; isError?: boolean };
    // An unanswered tool_use id is a 400 on the next round — one tool bug must
    // not become a dead loop.
    assert.equal(block.toolUseId, "tu_1");
    assert.equal(block.isError, true);
    assert.match(block.content, /tool exploded/);
  } finally {
    restore();
  }
});

test("the round ceiling stops a model that keeps calling tools, and says so", async () => {
  const restore = stubFetch([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_x", name: "get_weather", input: {} }] },
  ]);
  try {
    let ran = 0;
    const result = await runClaudeToolLoop({
      model: "claude-sonnet-4-6",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "loop forever" }],
      tools: [WEATHER],
      runTool: async () => { ran += 1; return "again"; },
      recordUsage: noUsage,
      maxRounds: 3,
    });
    assert.equal(result.rounds, 3);
    assert.equal(ran, 3);
    // The caller holds a partial answer; exhausted is how it knows not to ship it.
    assert.equal(result.exhausted, true);
  } finally {
    restore();
  }
});

// --- transport retry -------------------------------------------------------

test("a stalled request is retried, not surfaced as a dead turn", async () => {
  // AbortSignal.timeout raises TimeoutError, whose message says nothing about
  // "fetch failed". Before this was covered, a stalled request died outright
  // while a refused one recovered — and one agent turn makes several requests.
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    const body = { stop_reason: "end_turn", content: [{ type: "text", text: "recovered" }] };
    return {
      ok: true, status: 200, headers: new Headers(),
      json: async () => body, text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;

  try {
    const result = await runClaudeToolLoop({
      model: "claude-sonnet-4-6",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [WEATHER],
      runTool: async () => "ok",
      recordUsage: noUsage,
    });
    assert.equal(attempts, 2);
    assert.equal(result.text, "recovered");
  } finally {
    globalThis.fetch = original;
  }
});

test("describeTransportError names the cause, not undici's wrapper", async () => {
  const { describeTransportError } = await import("../llm-client.js");

  // What Holly actually saw during the proxy bursts: "fetch failed" on the
  // outside, the real reason one level down. Logging only the outer message is
  // what made a week of these undiagnosable.
  const wrapped = new TypeError("fetch failed");
  (wrapped as { cause?: unknown }).cause = Object.assign(
    new Error("Client network socket disconnected before secure TLS connection was established"),
    { code: "ECONNRESET" },
  );
  const described = describeTransportError(wrapped);
  assert.match(described, /fetch failed/);
  assert.match(described, /secure TLS connection/);
  assert.match(described, /code=ECONNRESET/);

  // A timeout has no cause, and must still describe itself.
  assert.match(
    describeTransportError(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    /TimeoutError/,
  );
  // Non-Errors must not crash the logger they were thrown into.
  assert.equal(describeTransportError("plain string"), "plain string");
});

// --- splitSystemPrompt preserves tool transcripts ---------------------------

// 这一组钉的是一个静默了很久的缺陷：splitSystemPrompt 曾经只看 content 判空，
// 于是 runToolLoop 每次开跑前都会把 ConversationLedger 里的工具轨迹压平——
// tool_result 回合（content 恒为 ""）被整条丢掉，侥幸活下来的回合也被重建成
// {role, content} 而丢掉 blocks。它不报 400，因为破坏是对称的：tool_use 和它的
// tool_result 一起消失，没有孤儿 id 能让 API 抱怨。代价是模型看不见自己调过什么
// 工具、拿回了什么，以及每次调用都必然重建缓存前缀。

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
