import { test } from "node:test";
import assert from "node:assert/strict";

import { buildOpenJevSearchRequest, parseOpenJevSearchResponse } from "../openjev-judge.js";
import { SEARCH_KEEP_CRITERIA, compareSearchJudgements } from "../search-judge-shadow.js";

const input = {
  topic: "天文学",
  topicBrief: "天文观测的最新进展",
  nowLabel: "2026-09-22 20:30",
  sinceLabel: "2026-09-21 20:30",
  results: [
    { title: "紫金山天文台", url: "http://www.pmo.cas.cn/", snippet: "科研动态" },
    { title: "", url: "about:blank", snippet: "" },
  ],
};

test("Open-Jev request puts the topic in the shared state and one noul question per result", () => {
  const request = buildOpenJevSearchRequest(input);
  assert.deepEqual(request.state, {
    now: "2026-09-22 20:30 (Beijing time)",
    window_starts: "2026-09-21 20:30",
    topic: "天文学",
    topic_scope: "天文观测的最新进展",
  });
  assert.deepEqual(Object.keys(request.questions), ["r1/keep", "r2/keep"]);
  const second = request.questions["r2/keep"] as {
    type: string;
    instructions: { result: Record<string, string> };
    criteria: unknown;
  };
  assert.equal(second.type, "noul");
  // 空标题、空摘要和生产里 主模型 看到的写法一致，而不是空串。
  assert.deepEqual(second.instructions.result, { title: "(untitled)", url: "about:blank", snippet: "(none)" });
  assert.deepEqual(second.criteria, SEARCH_KEEP_CRITERIA);
});

test("Open-Jev request omits topic_scope when there is no brief", () => {
  const request = buildOpenJevSearchRequest({ ...input, topicBrief: "" });
  assert.equal("topic_scope" in request.state, false);
});

test("Open-Jev response is read per question and thresholded", () => {
  const read = parseOpenJevSearchResponse({
    answers: {
      "r1/keep": { type: "noul", noul: 0.91 },
      "r2/keep": { type: "noul", noul: 0.2 },
    },
    metadata: { inference_seconds: 1.25 },
  }, 2, 0.5);
  assert.deepEqual(read, {
    verdicts: [
      { index: 1, pTrue: 0.91, keep: true },
      { index: 2, pTrue: 0.2, keep: false },
    ],
    serverSeconds: 1.25,
  });
});

test("Open-Jev response skips invalid probabilities and returns null when nothing is usable", () => {
  const partial = parseOpenJevSearchResponse({
    answers: {
      "r1/keep": { type: "noul", noul: 1.5 },
      "r2/keep": { type: "choice", noul: 0.4 },
      "r3/keep": { type: "noul", noul: 0.4 },
    },
  }, 3, 0.5);
  assert.deepEqual(partial?.verdicts, [{ index: 3, pTrue: 0.4, keep: false }]);
  assert.equal(partial?.serverSeconds, null);

  assert.equal(parseOpenJevSearchResponse({ answers: { "r1/keep": { type: "noul", noul: Number.NaN } } }, 1, 0.5), null);
  assert.equal(parseOpenJevSearchResponse({ error: "model inference failed" }, 1, 0.5), null);
  assert.equal(parseOpenJevSearchResponse(null, 1, 0.5), null);
});

test("shadow comparison separates the two directions of disagreement", () => {
  const comparison = compareSearchJudgements({
    results: [{ url: "a" }, { url: "b" }, { url: "c" }],
    primaryKeptIndexes: new Set([1, 2]),
    primaryReasons: new Map([[3, "学习平台，非新闻"]]),
    judgement: {
      verdicts: [
        { index: 1, pTrue: 0.9, keep: true },
        { index: 2, pTrue: 0.1, keep: false },
        { index: 3, pTrue: 0.7, keep: true },
      ],
    },
  });
  assert.equal(comparison.agree, 1);
  assert.equal(comparison.disagree, 2);
  assert.equal(comparison.primaryOnlyKeep, 1);
  assert.equal(comparison.shadowOnlyKeep, 1);
  assert.equal(comparison.rows[2].reason, "学习平台，非新闻");
});
