import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateEvalItems,
  bestBalancedThreshold,
  classifyDropReason,
  extractTitle,
  parseSearchJudgedLine,
  rocAuc,
} from "../openjev-eval.js";

function judgedLine(topic: string, lines: string[], ts = "2026-09-11T10:40:43.250Z"): string {
  return JSON.stringify({
    ts,
    kind: "status",
    title: "World Observation Search Judged",
    body: [`topic=${topic}`, "kept=0 dropped=0", ...lines].join("\n"),
  });
}

test("a Search Judged monitor line is parsed into keeps and drops with reasons", () => {
  const entry = parseSearchJudgedLine(judgedLine("数学", [
    "keep https://www.cms.org.cn/",
    "drop https://mathworld.net.cn/ | 数学百科资源站，非新闻",
  ]));
  assert.deepEqual(entry, {
    ts: "2026-09-11T10:40:43.250Z",
    topic: "数学",
    kept: ["https://www.cms.org.cn/"],
    dropped: [{ url: "https://mathworld.net.cn/", reason: "数学百科资源站，非新闻" }],
  });
  assert.equal(parseSearchJudgedLine(JSON.stringify({ ts: "x", title: "Other", body: "topic=数学" })), null);
  assert.equal(parseSearchJudgedLine("not json World Observation Search Judged"), null);
});

test("drop reasons split into page type and freshness, type winning when both appear", () => {
  assert.equal(classifyDropReason("学习平台，非新闻"), "type");
  assert.equal(classifyDropReason("光污染地图工具页，非新闻"), "type");
  assert.equal(classifyDropReason("8月4日文章，超出时间窗口"), "freshness");
  assert.equal(classifyDropReason("3天前，超出时间窗口"), "freshness");
  assert.equal(classifyDropReason("麦肯锡调研报告，非近期新闻"), "freshness");
  assert.equal(classifyDropReason("学习资料博客，时间过旧"), "type");
  assert.equal(classifyDropReason(""), "other");
});

test("repeated judgements collapse per topic and url", () => {
  const entries = [
    judgedLine("人工智能", ["keep https://a/", "drop https://b/ | 8月4日，超出时间窗口", "drop https://c/ | 学习平台，非新闻"]),
    judgedLine("人工智能", ["drop https://a/ | 3天前，超出时间窗口", "drop https://b/ | 8月4日，超出时间窗口", "keep https://c/"]),
    judgedLine("人工智能", ["drop https://d/ | 词典释义页，与AI无关"]),
    judgedLine("数学", ["keep https://d/"]),
  ].map((line) => parseSearchJudgedLine(line)!);
  const items = aggregateEvalItems(entries);
  const label = (topic: string, url: string) => items.find((item) => item.topic === topic && item.url === url)?.label;
  // 有过保留、其余只是时效丢弃：新闻类页面。
  assert.equal(label("人工智能", "https://a/"), "keep");
  assert.equal(label("人工智能", "https://b/"), "drop_freshness");
  // 同一个 url 既按类型丢过又被留过：主模型 自己前后不一致。
  assert.equal(label("人工智能", "https://c/"), "conflict");
  // 同一个 url 在不同话题下各算各的。
  assert.equal(label("人工智能", "https://d/"), "drop_type");
  assert.equal(label("数学", "https://d/"), "keep");
  assert.equal(items.find((item) => item.url === "https://b/")?.occurrences, 2);
});

test("a kept item is asked at the time it was last kept, others at the time they were last seen", () => {
  const entries = [
    judgedLine("人工智能", ["keep https://a/", "drop https://b/ | 学习平台，非新闻"], "2026-09-10T00:00:00.000Z"),
    judgedLine("人工智能", ["drop https://a/ | 3天前，超出时间窗口", "drop https://b/ | 学习平台，非新闻"], "2026-09-12T00:00:00.000Z"),
  ].map((line) => parseSearchJudgedLine(line)!);
  const items = aggregateEvalItems(entries);
  assert.equal(items.find((item) => item.url === "https://a/")?.contextTs, "2026-09-10T00:00:00.000Z");
  assert.equal(items.find((item) => item.url === "https://b/")?.contextTs, "2026-09-12T00:00:00.000Z");
});

test("ROC AUC ranks correctly and averages ties", () => {
  assert.equal(rocAuc([0.9, 0.8], [0.1, 0.2]), 1);
  assert.equal(rocAuc([0.1, 0.2], [0.9, 0.8]), 0);
  assert.equal(rocAuc([0.5, 0.5], [0.5, 0.5]), 0.5);
  assert.equal(rocAuc([0.9, 0.3], [0.5]), 0.5);
  assert.equal(rocAuc([], [0.5]), null);
});

test("best threshold is searched over observed scores", () => {
  // 两类完全分开时，线落在正类的最低分上，平衡准确率为 1。
  assert.deepEqual(bestBalancedThreshold([0.7, 0.9], [0.4, 0.6]), { threshold: 0.7, balancedAccuracy: 1 });
  assert.equal(bestBalancedThreshold([], [0.4]), null);
});

test("titles are decoded with the page's declared charset", () => {
  const utf8 = new TextEncoder().encode("<html><title> 雷锋网 &amp; AI\n</title></html>");
  assert.equal(extractTitle(utf8, "text/html; charset=utf-8"), "雷锋网 & AI");

  // 「中文」的 GBK 编码是 D6 D0 CE C4，字符集只写在 meta 里。
  const head = new TextEncoder().encode('<meta charset="gbk"><title>');
  const tail = new TextEncoder().encode("</title>");
  const gbk = new Uint8Array([...head, 0xd6, 0xd0, 0xce, 0xc4, ...tail]);
  assert.equal(extractTitle(gbk, "text/html"), "中文");

  assert.equal(extractTitle(new TextEncoder().encode("<p>no title</p>"), ""), "");
});
