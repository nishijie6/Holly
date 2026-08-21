import assert from "node:assert/strict";
import test from "node:test";

import {
  broadcastTextSimilarity,
  buildFallbackBroadcastItem,
  containsChineseText,
  extractRecentBroadcastItems,
  extractSummaryProse,
  isDuplicateBroadcastText,
  normalizeBroadcastUrl,
} from "../world-observation-dedup.js";

test("normalizeBroadcastUrl removes fragments, tracking parameters, and trailing slash", () => {
  assert.equal(
    normalizeBroadcastUrl("https://example.com/news/?utm_source=qq&id=7#comments"),
    "https://example.com/news?id=7",
  );
});

test("extractRecentBroadcastItems restores sent items from persisted conversation turns", () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z");
  const items = extractRecentBroadcastItems([
    {
      role: "assistant",
      timestamp: "2026-08-11T12:00:00.000Z",
      content: "天文速览：\n1. 蓝眼初鸣团队首次探测到射电脉冲。 https://example.com/a?utm_source=qq",
    },
    {
      role: "assistant",
      timestamp: "2026-08-11T13:00:00.000Z",
      content: "世界观察失败: 天文学 — 页面为空 https://example.com/error",
    },
    {
      role: "user",
      timestamp: "2026-08-11T14:00:00.000Z",
      content: "https://example.com/user-link",
    },
  ], now, 7 * 24 * 60 * 60 * 1000);

  assert.deepEqual(items.map(({ text, normalizedUrl }) => ({ text, normalizedUrl })), [{
    text: "蓝眼初鸣团队首次探测到射电脉冲。",
    normalizedUrl: "https://example.com/a",
  }]);
});

test("semantic dedup catches rewritten versions of the same event", () => {
  const earlier = "国家天文台蓝眼初鸣团队首次在中心致密天体中探测到射电脉冲。";
  const rewritten = "蓝眼初鸣团队首次在中心致密天体中探测到射电脉冲，为致密天体研究带来新突破。";
  assert.ok(broadcastTextSimilarity(earlier, rewritten) > 0.58);
  assert.equal(isDuplicateBroadcastText(rewritten, [earlier]), true);
  assert.equal(
    isDuplicateBroadcastText("英伟达开源发布300亿参数MoE模型，面向本地推理。", [earlier]),
    false,
  );
});

test("items outside the dedup window are ignored", () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z");
  const items = extractRecentBroadcastItems([{
    role: "assistant",
    timestamp: "2026-08-01T12:00:00.000Z",
    content: "旧消息 https://example.com/old",
  }], now, 7 * 24 * 60 * 60 * 1000);
  assert.equal(items.length, 0);
});

test("extractSummaryProse strips the browser-observation header, titles, source lines, and detail links block", () => {
  const summary = [
    "[Browser observation] query=天文学 最新 进展",
    "",
    "1. 中国科学院上海天文台",
    "Source: https://shao.cas.cn/twxjz/",
    "《天文学进展》是中国科学院上海天文台和中国天文学会主办的天文学类核心期刊，主要刊登反映国内外天文学各分支学科最新研究进展的评述性文章。",
    "Detail links:",
    "- 过刊浏览>>: https://shao.cas.cn/twxjz/wzll/",
    "- GRB 221009A的观测及理论研究进展: https://shao.cas.cn/twxjz/some-article",
  ].join("\n");

  assert.equal(
    extractSummaryProse(summary),
    "《天文学进展》是中国科学院上海天文台和中国天文学会主办的天文学类核心期刊，主要刊登反映国内外天文学各分支学科最新研究进展的评述性文章。",
  );
});

test("buildFallbackBroadcastItem quotes real prose when the structured extraction pass found nothing", () => {
  const summary = [
    "[Browser observation] query=天文学 最新 进展",
    "1. 中国科学院上海天文台",
    "Source: https://shao.cas.cn/twxjz/",
    "《天文学进展》是中国科学院上海天文台和中国天文学会主办的天文学类核心期刊，主要刊登反映国内外天文学各分支学科最新研究进展的评述性文章，也发表研究论文、学科前沿介绍等稿件。",
    "Detail links:",
    "- 过刊浏览>>: https://shao.cas.cn/twxjz/wzll/",
  ].join("\n");

  const item = buildFallbackBroadcastItem(summary, ["https://shao.cas.cn/twxjz/"]);
  assert.ok(item);
  assert.equal(item?.url, "https://shao.cas.cn/twxjz/");
  assert.ok(containsChineseText(item!.text));
  assert.ok(item!.text.length <= 150);
});

test("buildFallbackBroadcastItem refuses short or non-Chinese content instead of manufacturing a broadcast", () => {
  assert.equal(
    buildFallbackBroadcastItem(
      "[Browser observation] query=x\n1. Title\nSource: https://example.com\nToo short.",
      ["https://example.com"],
    ),
    null,
  );
  assert.equal(buildFallbackBroadcastItem("", []), null);
});
