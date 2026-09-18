import { test } from "node:test";
import assert from "node:assert/strict";

import { createSelfToolRunner, SELF_SUBTOOL_NAMES, type SelfToolDeps } from "../self-tools.js";
import type { LlmToolUseBlock } from "../llm-client.js";

function harness(overrides: Partial<SelfToolDeps> = {}) {
  const memories: Array<{ topic: string; content: string }> = [];
  const archives: Array<{ kind: string; title: string; content: string }> = [];
  const observed: string[] = [];
  const deps: SelfToolDeps = {
    writeMemory: async ({ topic, content }) => { memories.push({ topic, content }); },
    writeArchive: async ({ kind, title, content }) => { archives.push({ kind, title, content }); },
    observeWorld: async (topic) => { observed.push(topic); return { summary: `[${topic}] 最近有这些` }; },
    worldTopics: () => ["人工智能", "天文学"],
    ...overrides,
  };
  const run = createSelfToolRunner(deps);
  const call = (name: string, input: Record<string, unknown> = {}) =>
    run({ type: "tool_use", id: "tu_1", name, input } as LlmToolUseBlock).then((raw) => JSON.parse(raw));
  return { call, memories, archives, observed };
}

test("记一件事", async () => {
  const { call, memories } = harness();
  const result = await call("write_memory", { topic: "关于噪音", content: "今天群里聊到耳鸣" });
  assert.equal(result.ok, true);
  assert.deepEqual(memories, [{ topic: "关于噪音", content: "今天群里聊到耳鸣" }]);
});

test("写一首诗", async () => {
  const { call, archives } = harness();
  const result = await call("write_archive", { kind: "poem", title: "星尘", content: "第一行\n第二行" });
  assert.equal(result.ok, true);
  assert.deepEqual(archives, [{ kind: "poem", title: "星尘", content: "第一行\n第二行" }]);
});

// kind 只有两种。填了别的按文章处理，而不是拒绝——她想写的东西已经在 content 里了，
// 为一个分类字段把整次调用打回去，代价和收益不成比例。
test("kind 填了别的就当文章", async () => {
  const { call, archives } = harness();
  await call("write_archive", { kind: "散文", title: "某日", content: "正文" });
  assert.equal(archives[0].kind, "article");
});

test("空正文被挡下，并说清该填什么", async () => {
  const { call, memories } = harness();
  const result = await call("write_memory", { topic: "有题目", content: "   " });
  assert.equal(result.ok, false);
  assert.match(result.note, /content/);
  assert.deepEqual(memories, [], "挡下就不该落盘");
});

test("没题目也挡下", async () => {
  const { call, archives } = harness();
  const result = await call("write_archive", { kind: "poem", content: "有正文没标题" });
  assert.equal(result.ok, false);
  assert.deepEqual(archives, []);
});

// 落盘抛错不能被吞掉：她以为记下了、其实没记，比当场报错更糟。
test("落盘失败会抛出去，不假装写成了", async () => {
  const { call } = harness({ writeMemory: async () => { throw new Error("disk full"); } });
  await assert.rejects(() => call("write_memory", { topic: "t", content: "c" }), /disk full/);
});

test("看一眼世界，拿回摘要", async () => {
  const { call, observed } = harness();
  const result = await call("observe_world", { topic: "天文学" });
  assert.equal(result.ok, true);
  assert.match(result.summary, /天文学/);
  assert.deepEqual(observed, ["天文学"]);
});

// 这个工具只负责看。以前观察完会自动走一整套播报判断替她决定发不发；现在东西回到她手上，
// 说不说是她自己的事——返回里的提示就是在说这件事。
test("看完不替她发，提示她自己决定", async () => {
  const { call } = harness();
  const result = await call("observe_world", { topic: "天文学" });
  assert.match(result.note, /send_message/);
  assert.match(result.note, /不值得说就放着/);
});

// 话题按原文逐字匹配配置：每个话题的固定来源页是按名字配的，编一个名字就没有来源可读。
test("话题不在配置里就挡下，并给出能看的名单", async () => {
  const { call, observed } = harness();
  const result = await call("observe_world", { topic: "股市" });
  assert.equal(result.ok, false);
  assert.match(result.note, /人工智能/);
  assert.match(result.note, /天文学/);
  assert.deepEqual(observed, [], "挡下就不该真去看");
});

test("什么都没看到时说清楚，不编一段摘要", async () => {
  const { call } = harness({ observeWorld: async () => null });
  const result = await call("observe_world", { topic: "天文学" });
  assert.equal(result.ok, false);
  assert.match(result.note, /没看到/);
});

test("名单就是这三个", () => {
  assert.deepEqual([...SELF_SUBTOOL_NAMES], ["write_memory", "write_archive", "observe_world"]);
});
