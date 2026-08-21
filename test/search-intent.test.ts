import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeSearchQuery, resolveExplicitSearchRequest } from "../search-intent.js";

test("explicit QQ search follow-up reuses the immediately preceding topic", () => {
  const request = resolveExplicitSearchRequest({
    message: "10:17:58 群聊 [示例群(20000002)] [小明(10000001)] 你搜索一下",
    referenceTime: "2026-08-13T02:17:58.000Z",
    context: [
      {
        content: "10:16:59 群聊 [示例群(20000002)] [小明(10000001)] 昨天有个大人物去世了，你知道吗",
        timestamp: "2026-08-13T02:16:59.000Z",
      },
      {
        content: "10:17:58 群聊 [示例群(20000002)] [小明(10000001)] 你搜索一下",
        timestamp: "2026-08-13T02:17:58.000Z",
      },
    ],
  });

  assert.deepEqual(request, {
    requested: true,
    query: '"2026年8月12日" 逝世',
    usedPreviousContext: true,
  });
});

test("explicit QQ search follow-up uses conversation context without a time cutoff", () => {
  const request = resolveExplicitSearchRequest({
    message: "10:41:19 群聊 [示例群(20000002)] [小明(10000001)] 你搜索一下",
    referenceTime: "2026-08-15T02:41:19.000Z",
    context: [
      {
        content: "10:16:59 群聊 [示例群(20000002)] [小明(10000001)] 昨天有个大人物去世了，你知道吗",
        timestamp: "2026-08-13T02:16:59.000Z",
      },
      {
        content: "10:17:58 群聊 [示例群(20000002)] [小明(10000001)] 你搜索一下",
        timestamp: "2026-08-13T02:17:58.000Z",
      },
      {
        content: "10:41:19 群聊 [示例群(20000002)] [小明(10000001)] 你搜索一下",
        timestamp: "2026-08-13T02:41:19.000Z",
      },
    ],
  });

  assert.deepEqual(request, {
    requested: true,
    query: '"2026年8月12日" 逝世',
    usedPreviousContext: true,
  });
});

test("explicit search command extracts an inline query", () => {
  assert.deepEqual(
    resolveExplicitSearchRequest({ message: "Holly，帮我联网搜一下 OpenAI 最新模型" }),
    {
      requested: true,
      query: "OpenAI 最新模型",
      usedPreviousContext: false,
    },
  );
  assert.equal(
    resolveExplicitSearchRequest({ message: "OpenAI 最新模型你搜一下" }).query,
    "OpenAI 最新模型",
  );
});

test("noun use of search does not force a lookup", () => {
  assert.deepEqual(
    resolveExplicitSearchRequest({ message: "搜索算法怎么实现" }),
    { requested: false, query: "", usedPreviousContext: false },
  );
});

test("an omitted search target follows the nearest meaningful conversation turn", () => {
  const request = resolveExplicitSearchRequest({
    message: "你查一下",
    referenceTime: "2026-08-20T04:30:01.000Z",
    context: [
      { content: "旧话题：火星天气", timestamp: "2026-08-01T01:00:00.000Z" },
      { content: "昨天有个大人物去世了", timestamp: "2026-08-13T01:00:00.000Z" },
    ],
  });

  assert.equal(request.query, '"2026年8月12日" 逝世');
  assert.equal(request.usedPreviousContext, true);
});

test("model-generated relative obituary queries are normalized for the search engine", () => {
  assert.equal(
    normalizeSearchQuery("昨天去世的名人 大人物", "2026-08-13T02:17:58.000Z"),
    '"2026年8月12日" 逝世',
  );
});
