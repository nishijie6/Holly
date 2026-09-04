import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClaudeRequestBody,
  digestClaudeCachedPrefix,
  parseClaudeToolUses,
  runClaudeToolLoop,
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
    assert.equal(result.messages.length, 3);
    assert.equal(result.messages[0].content, "weather?");
    assert.equal(result.messages[1].blocks?.[0].type, "tool_use");
    assert.equal(result.messages[2].blocks?.[0].type, "tool_result");
  } finally {
    restore();
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
    const resultTurn = result.messages.at(-1);
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
    const block = result.messages.at(-1)?.blocks?.[0] as { toolUseId: string; content: string; isError?: boolean };
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
