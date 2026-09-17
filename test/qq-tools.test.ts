import assert from "node:assert/strict";
import test from "node:test";

import { QQ_TOOL_DEFINITIONS, createQqToolRunner } from "../qq-tools.js";
import type { ConversationSummary, QqToolDeps } from "../qq-tools.js";
import type { LlmToolUseBlock } from "../llm-client.js";

// The tools that move Holly's attention. The property worth defending is that
// focus is not something the model can assert — it can ask to move it, and only
// open_conversation moves it. send_message therefore has no target argument, so
// a hallucinated group id has nowhere to land.

const CONVERSATIONS: ConversationSummary[] = [
  { id: "qq_group:100", name: "群甲", unread: 3, lastMessage: "等你的茶", lastAt: "2026-09-04T08:00:00Z" },
  { id: "qq_group:200", name: "群乙", unread: 0, lastMessage: "（无新消息）", lastAt: null },
];

function harness(overrides: Partial<QqToolDeps> = {}) {
  let focus: string | null = null;
  const sent: Array<{ id: string; message: string }> = [];
  const searched: string[] = [];
  const read: string[] = [];
  const deps: QqToolDeps = {
    listConversations: async () => CONVERSATIONS,
    readConversation: async (id) => (CONVERSATIONS.some((c) => c.id === id) ? [`${id} 的最近消息`] : null),
    sendToConversation: async (id, message) => { sent.push({ id, message }); return "msg_1"; },
    getFocus: () => focus,
    setFocus: (id) => { focus = id; },
    canSend: () => ({ allowed: true, reason: "" }),
    roundConversationId: null,
    searchWeb: async (query) => {
      searched.push(query);
      return { ok: true, text: `[联网搜索结果] 关于「${query}」查到以下资料` };
    },
    readPage: async (url) => {
      read.push(url);
      return { ok: true, text: `[网页正文] ${url}` };
    },
    ...overrides,
  };
  const bind = (run: ReturnType<typeof createQqToolRunner>) =>
    (name: string, input: Record<string, unknown> = {}) =>
      run({ type: "tool_use", id: "tu_1", name, input } as LlmToolUseBlock).then((raw) => JSON.parse(raw));
  const call = bind(createQqToolRunner(deps));
  // 下一轮：焦点和发送记录沿用，runner 新建一个——main.ts 每轮就是这么做的。
  const nextRound = (roundConversationId: string | null) =>
    bind(createQqToolRunner({ ...deps, roundConversationId }));
  return { call, nextRound, sent, searched, read, focus: () => focus };
}

test("the five tools are declared with closed schemas", () => {
  assert.deepEqual(QQ_TOOL_DEFINITIONS.map((t) => t.name), [
    "list_conversations",
    "open_conversation",
    "send_message",
    "search_web",
    "read_page",
  ]);
  for (const tool of QQ_TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} should reject extra args`);
  }
});

// --- list_conversations ----------------------------------------------------

test("list_conversations returns the roster and reports the current focus", async () => {
  const { call } = harness();
  const listed = await call("list_conversations");
  assert.equal(listed.ok, true);
  assert.equal(listed.current, null);
  assert.equal(listed.conversations.length, 2);
});

test("list_conversations does not move focus", async () => {
  const { call, focus } = harness();
  await call("list_conversations");
  assert.equal(focus(), null);
});

// --- open_conversation -----------------------------------------------------

test("open_conversation shows the messages and takes focus", async () => {
  const { call, focus } = harness();
  const opened = await call("open_conversation", { id: "qq_group:100" });
  assert.equal(opened.ok, true);
  assert.equal(opened.current, "qq_group:100");
  assert.deepEqual(opened.recent, ["qq_group:100 的最近消息"]);
  assert.equal(focus(), "qq_group:100");
});

test("opening an unknown conversation refuses and leaves focus alone", async () => {
  const { call, focus } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  const missed = await call("open_conversation", { id: "qq_group:999" });
  assert.equal(missed.ok, false);
  // Focus must not be moved to somewhere that does not exist.
  assert.equal(focus(), "qq_group:100");
});

test("open_conversation with no id explains how to get one", async () => {
  const { call } = harness();
  const bad = await call("open_conversation", {});
  assert.equal(bad.ok, false);
  assert.match(bad.note, /list_conversations/);
});

// --- send_message ----------------------------------------------------------

test("send_message goes to whatever is currently open", async () => {
  const { call, sent } = harness();
  await call("open_conversation", { id: "qq_group:200" });
  const result = await call("send_message", { message: "在的" });
  assert.equal(result.ok, true);
  assert.equal(result.conversationId, "qq_group:200");
  assert.deepEqual(sent, [{ id: "qq_group:200", message: "在的" }]);
});

test("send_message with nothing open refuses instead of guessing a target", async () => {
  const { call, sent } = harness();
  const result = await call("send_message", { message: "在的" });
  assert.equal(result.ok, false);
  assert.match(result.note, /open_conversation/);
  assert.deepEqual(sent, []);
});

test("send_message cannot be aimed by argument", async () => {
  const { call, sent } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  // A model that invents a target gets ignored: there is no target parameter,
  // and the extra key is not read.
  await call("send_message", { message: "hi", id: "qq_group:999", conversationId: "qq_group:999" });
  assert.deepEqual(sent, [{ id: "qq_group:100", message: "hi" }]);
});

test("an empty message is refused", async () => {
  const { call, sent } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  const result = await call("send_message", { message: "   " });
  assert.equal(result.ok, false);
  assert.deepEqual(sent, []);
});

test("a suppressed send comes back as a result the model can read, not a throw", async () => {
  const { call, sent } = harness({
    canSend: () => ({ allowed: false, reason: "QQ 处于观察模式，不发送。" }),
  });
  await call("open_conversation", { id: "qq_group:100" });
  const result = await call("send_message", { message: "在的" });
  assert.equal(result.ok, false);
  assert.match(result.note, /观察模式/);
  assert.deepEqual(sent, []);
});

// 2026-09-10 的串群：焦点停在上一轮打开的 20000001，20000003 的通知进来，模型没打开
// 766 就复读，话进了 253。下面几条钉住这项检查的边界——拦过期焦点，不拦有意换群。

test("焦点停在上一轮打开的会话、本轮消息来自别处时，不重新打开就发会被拒", async () => {
  const { call, nextRound, sent, focus } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  const round = nextRound("qq_group:200");
  const result = await round("send_message", { message: "今天真热啊" });
  assert.equal(result.ok, false);
  assert.match(result.note, /open_conversation/);
  assert.ok(result.note.includes("qq_group:200"), "拒绝理由要点名本轮消息来自的会话");
  assert.deepEqual(sent, []);
  // 拒发不等于替模型换焦点：打开哪里仍然只由 open_conversation 决定。
  assert.equal(focus(), "qq_group:100");
});

test("本轮打开了消息来自的会话，就照常发到那里", async () => {
  const { call, nextRound, sent } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  const round = nextRound("qq_group:200");
  await round("open_conversation", { id: "qq_group:200" });
  const result = await round("send_message", { message: "今天真热啊" });
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ id: "qq_group:200", message: "今天真热啊" }]);
});

test("本轮主动打开别的会话再说话是有意换群，放行", async () => {
  const { nextRound, sent } = harness();
  const round = nextRound("qq_group:200");
  await round("open_conversation", { id: "qq_group:100" });
  const result = await round("send_message", { message: "接一句" });
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ id: "qq_group:100", message: "接一句" }]);
});

test("焦点本来就在本轮的会话上（前台切焦点就是这样），不用再打开", async () => {
  const { call, nextRound, sent } = harness();
  await call("open_conversation", { id: "qq_group:200" });
  const result = await nextRound("qq_group:200")("send_message", { message: "在的" });
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ id: "qq_group:200", message: "在的" }]);
});

test("打开失败不算本轮打开过", async () => {
  const { call, nextRound, sent } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  const round = nextRound("qq_group:200");
  await round("open_conversation", { id: "qq_group:999" });
  const result = await round("send_message", { message: "在的" });
  assert.equal(result.ok, false);
  assert.deepEqual(sent, []);
});

test("an unknown tool name is refused rather than throwing", async () => {
  const { call } = harness();
  const result = await call("delete_everything", {});
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown tool/);
});

// --- search_web ------------------------------------------------------------
//
// 一次搜索十几秒。工具自己先把「我搜一下」发出去，是为了让等的人立刻看见动静；下面几条
// 钉的是这句话的边界：只发一次、不发到错的群、发不出去也不耽误搜索。

test("search_web 先把那句话发到当前会话,再去搜", async () => {
  const { call, sent, searched } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  const result = await call("search_web", { query: "长沙 天气", saying: "我搜一下哈" });
  assert.equal(result.ok, true);
  assert.equal(result.noticeSent, true);
  assert.match(result.results, /长沙 天气/);
  assert.deepEqual(sent, [{ id: "qq_group:100", message: "我搜一下哈" }]);
  assert.deepEqual(searched, ["长沙 天气"]);
});

test("一轮里搜第二次,不再重复说「我搜一下」", async () => {
  const { call, sent } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  await call("search_web", { query: "长沙 天气", saying: "我搜一下" });
  const second = await call("search_web", { query: "长沙 明天 天气", saying: "再搜一下" });
  assert.equal(second.ok, true);
  assert.equal(second.noticeSent, false);
  assert.equal(sent.length, 1);
});

test("saying 留空也有一句兜底的话,不让人干等", async () => {
  const { call, sent } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  await call("search_web", { query: "OpenAI 最新模型" });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].message.trim().length > 0);
});

test("焦点还停在上一轮的会话上时,那句话不会误发过去,搜索照做", async () => {
  const { call, nextRound, sent, searched } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  const round = nextRound("qq_group:200");
  const result = await round("search_web", { query: "长沙 天气", saying: "我搜一下" });
  assert.equal(result.ok, true);
  assert.equal(result.noticeSent, false);
  assert.deepEqual(sent, []);
  assert.deepEqual(searched, ["长沙 天气"]);
});

test("发送被抑制时不发那句话,但搜索照样做完", async () => {
  const { call, sent, searched } = harness({
    canSend: () => ({ allowed: false, reason: "QQ 处于观察模式，不发送。" }),
  });
  await call("open_conversation", { id: "qq_group:100" });
  const result = await call("search_web", { query: "长沙 天气", saying: "我搜一下" });
  assert.equal(result.ok, true);
  assert.equal(result.noticeSent, false);
  assert.deepEqual(sent, []);
  assert.deepEqual(searched, ["长沙 天气"]);
});

test("那句话发失败,搜索不受影响", async () => {
  const { call, searched } = harness({
    sendToConversation: async () => { throw new Error("NapCat 断线"); },
  });
  await call("open_conversation", { id: "qq_group:100" });
  const result = await call("search_web", { query: "长沙 天气", saying: "我搜一下" });
  assert.equal(result.ok, true);
  assert.equal(result.noticeSent, false);
  assert.deepEqual(searched, ["长沙 天气"]);
});

test("空 query 直接拒,不会白发一句「我搜一下」", async () => {
  const { call, sent, searched } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  const result = await call("search_web", { query: "   ", saying: "我搜一下" });
  assert.equal(result.ok, false);
  assert.deepEqual(sent, []);
  assert.deepEqual(searched, []);
});

test("搜索不可用时,把原因原样交回模型", async () => {
  const { call } = harness({
    searchWeb: async () => ({ ok: false, text: "联网搜索当前没有启用。" }),
  });
  await call("open_conversation", { id: "qq_group:100" });
  const result = await call("search_web", { query: "长沙 天气", saying: "我搜一下" });
  assert.equal(result.ok, false);
  assert.match(result.note, /没有启用/);
});

// --- read_page -------------------------------------------------------------

test("read_page 先说一句再打开页面,正文交回模型", async () => {
  const { call, sent, read } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  const result = await call("read_page", { url: "https://example.com/a", saying: "我点进去看看" });
  assert.equal(result.ok, true);
  assert.equal(result.noticeSent, true);
  assert.match(result.content, /example\.com/);
  assert.deepEqual(sent, [{ id: "qq_group:100", message: "我点进去看看" }]);
  assert.deepEqual(read, ["https://example.com/a"]);
});

// 搜一下、再点开细看，是一轮里最常见的组合。两个工具共用同一个「本轮已经说过」的标记，
// 否则她会连着说「我搜一下」「我点进去看看」，像在自言自语。
test("搜完紧接着点开,不再重复吆喝一声", async () => {
  const { call, sent } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  await call("search_web", { query: "长沙 天气", saying: "我搜一下" });
  const opened = await call("read_page", { url: "https://example.com/a", saying: "我点进去看看" });
  assert.equal(opened.ok, true);
  assert.equal(opened.noticeSent, false);
  assert.deepEqual(sent, [{ id: "qq_group:100", message: "我搜一下" }]);
});

test("空 url 直接拒,不会白发一句话", async () => {
  const { call, sent, read } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  const result = await call("read_page", { url: "   ", saying: "我点进去看看" });
  assert.equal(result.ok, false);
  assert.deepEqual(sent, []);
  assert.deepEqual(read, []);
});

test("页面打不开时,原因原样交回模型", async () => {
  const { call } = harness({
    readPage: async () => ({ ok: false, text: "这个地址不能打开：只支持公网的 http/https 网页。" }),
  });
  await call("open_conversation", { id: "qq_group:100" });
  const result = await call("read_page", { url: "http://127.0.0.1:8888/", saying: "我看看" });
  assert.equal(result.ok, false);
  assert.match(result.note, /公网/);
});

test("焦点还停在上一轮的会话上时,那句话不会误发过去,页面照读", async () => {
  const { call, nextRound, sent, read } = harness();
  await call("open_conversation", { id: "qq_group:100" });
  const round = nextRound("qq_group:200");
  const result = await round("read_page", { url: "https://example.com/a", saying: "我点进去看看" });
  assert.equal(result.ok, true);
  assert.equal(result.noticeSent, false);
  assert.deepEqual(sent, []);
  assert.deepEqual(read, ["https://example.com/a"]);
});
