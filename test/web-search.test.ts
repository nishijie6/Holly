import { test } from "node:test";
import assert from "node:assert/strict";

import { searchWeb } from "../web-search.js";

function jsonResponse(results: Array<{ title: string; url: string; content: string }>): Response {
  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("obituary searches fall back to alternate Chinese search engines", async () => {
  const originalFetch = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const query = url.searchParams.get("q") ?? "";
    queries.push(query);
    if (query.startsWith("!360so") || query.startsWith("!bd")) {
      return jsonResponse([
        { title: "某重要人物逝世", url: "https://www.news.cn/a", content: "新华社讣告" },
      ]);
    }
    return jsonResponse([
      { title: "普通日期页面", url: "https://example.com/date", content: "没有相关事件" },
    ]);
  }) as typeof fetch;

  try {
    const results = await searchWeb('"2026年8月12日" 逝世', { topK: 5 });
    assert.equal(queries.length, 3);
    assert.ok(queries.some((query) => query.startsWith("!360so")));
    assert.ok(queries.some((query) => query.startsWith("!bd")));
    assert.equal(results[0]?.url, "https://www.news.cn/a");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ordinary searches use one SearXNG request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse([
      { title: "OpenAI", url: "https://openai.com", content: "Current model information" },
    ]);
  }) as typeof fetch;

  try {
    const results = await searchWeb("OpenAI 最新模型", { topK: 5 });
    assert.equal(calls, 1);
    assert.equal(results[0]?.url, "https://openai.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
