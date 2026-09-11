import assert from "node:assert/strict";
import test from "node:test";

import {
  buildArchiveCompositionPrompt,
  buildMemoryReflectionPrompt,
  buildWorldObservationBroadcastPrompt,
  isTruncatedBroadcastText,
  selectBroadcastItems,
} from "../autonomy-prompts.js";

const worldBlocks = [
  "World observation 1:\n- topic: 天文学\n- summary: 一些内容",
  "World observation 2:\n- topic: 数学趣题\n- summary: 另一些内容",
];
const churn = ["Internal memory 1:\n- content: 刚写下的记忆", "Recent conversation:\n- 有人说了句话"];

// The whole point of the split: two ticks that see the same world-observation
// window must produce byte-identical stable halves, or the cache entry the
// breakpoint creates is dead on arrival.
test("memory reflection's stable half is byte-identical across ticks", () => {
  const first = buildMemoryReflectionPrompt("2026-09-06T13:00:00.000Z", "tick", worldBlocks, churn);
  const second = buildMemoryReflectionPrompt(
    "2026-09-06T13:33:00.000Z",
    "another tick",
    worldBlocks,
    [...churn, "Internal memory 2:\n- content: 又一条"],
  );

  assert.equal(first.stable, second.stable);
  assert.notEqual(first.volatile, second.volatile);
});

// now/reason used to sit ahead of the material. A timestamp anywhere in the
// prefix invalidates everything after it, so this is the regression that would
// silently undo the split while every test about content still passed.
test("timestamps stay out of the cached half", () => {
  const nowIso = "2026-09-06T13:00:00.000Z";
  const memory = buildMemoryReflectionPrompt(nowIso, "tick", worldBlocks, churn);
  assert.ok(!memory.stable.includes(nowIso), "now must not appear in the stable half");
  assert.ok(!memory.stable.includes("reason="), "reason must not appear in the stable half");
  assert.ok(memory.volatile.includes(nowIso));

  const archive = buildArchiveCompositionPrompt(nowIso, "tick", ["- [poem] 旧作"], worldBlocks, churn);
  assert.ok(!archive.stable.includes(nowIso), "now must not appear in the stable half");
  assert.ok(archive.volatile.includes(nowIso));
});

// Recent titles grow every time Holly writes, so they belong with the churn.
test("archive composition keeps recent titles in the volatile half", () => {
  const withTitles = buildArchiveCompositionPrompt(
    "2026-09-06T13:00:00.000Z", "tick", ["- [poem] 雨夜"], worldBlocks, churn,
  );
  const withoutTitles = buildArchiveCompositionPrompt(
    "2026-09-06T13:00:00.000Z", "tick", [], worldBlocks, churn,
  );

  assert.equal(withTitles.stable, withoutTitles.stable, "a new work must not disturb the prefix");
  assert.ok(withTitles.volatile.includes("雨夜"));
  assert.ok(!withoutTitles.volatile.includes("Recent works"));
});

// Both halves still have to carry the instructions and the material the model
// needs — a split that drops content would cache beautifully and answer badly.
test("the split preserves instructions and material", () => {
  const { stable, volatile } = buildMemoryReflectionPrompt(
    "2026-09-06T13:00:00.000Z", "tick", worldBlocks, churn,
  );
  assert.ok(stable.includes("Holly's private memory and reflection loop"));
  assert.ok(stable.includes("should_write"));
  for (const block of worldBlocks) assert.ok(stable.includes(block));
  for (const block of churn) assert.ok(volatile.includes(block));
});

// An empty world-observation window is normal at boot and after a quiet day.
test("an empty stable half degrades to instructions only", () => {
  const { stable, volatile } = buildMemoryReflectionPrompt(
    "2026-09-06T13:00:00.000Z", "tick", [], churn,
  );
  assert.ok(stable.includes("Holly's private memory and reflection loop"));
  assert.ok(!stable.endsWith("\n"), "no trailing blank line when there is no material");
  for (const block of churn) assert.ok(volatile.includes(block));
});

// ---------- 播报条目的完整性检查 ----------

// 2026-09-05 到 09-10 真实发进群里的截断条目，从监控日志原样摘出。每一条都停在句子中间。
const TRUNCATED_BROADCAST_TEXTS = [
  "北京经开区推出",
  "OpenAI就旗下智能体向德国维基站点写入内容的",
  "世界模型不再只做未来预测，机器人本体与",
  "李飞飞团队用三张照片替代两小时扫街采集，主打",
  "400亿AI短剧市场爆冷：市场规模翻了一倍多，公司却跑了九成，号称",
  "火山引擎内测AI版权平台，Seedance从",
  "千问办公推出业内首个",
  "AI仅用11天、30万美元攻破困扰数学界358年的费马大定理最后一环，被评",
  "黄仁勋半年内第三次喊出",
  "国内首例：六人利用",
  "号称",
  "联想IDG总裁称AI PC的",
  "AI社交收入暴涨12倍，微信也已下场，模式从",
  "美国国防部被曝曾要求OpenAI提供",
  "Arm将战线推向x86腹地，",
  "另一篇关于代码风格的分享《",
  "博客园作者",
];

test("isTruncatedBroadcastText flags every truncated item that actually reached a group", () => {
  for (const text of TRUNCATED_BROADCAST_TEXTS) {
    assert.equal(isTruncatedBroadcastText(text), true, text);
  }
});

test("isTruncatedBroadcastText accepts text that ends like a finished sentence", () => {
  for (const text of [
    // 前两条是历史上真实发出的完整条目，历史上所有完整条目都以「。」或「？」结尾。
    "想看更多趣题可以点这里换一批。",
    "挂钟敲6下用30秒，敲12下要多少秒？",
    "黄仁勋半年内第三次喊出「AGI已经到来」",
    "推荐阅读《数学之美》",
    "这篇值得一看！",
    "Anthropic released Claude Opus 5.",
    "来看看吧～",
    "这个理由绝了😂",
    "  前后带空白也照样算完整。  ",
  ]) {
    assert.equal(isTruncatedBroadcastText(text), false, text);
  }
});

test("isTruncatedBroadcastText does not call an empty string truncated", () => {
  assert.equal(isTruncatedBroadcastText(""), false);
  assert.equal(isTruncatedBroadcastText("   "), false);
});

test("selectBroadcastItems drops only the truncated items and keeps the rest of the same reply", () => {
  const urls = ["https://a.example/1", "https://a.example/2", "https://a.example/3"];
  const selection = selectBroadcastItems(
    [
      { text: "京东启动物理AI加速计划。", url: urls[0] },
      { text: "黄仁勋半年内第三次喊出", url: urls[1] },
      { text: "FAST 发布第二十六批科学数据。", url: urls[2] },
    ],
    urls,
  );

  assert.deepEqual(selection.items, [
    { text: "京东启动物理AI加速计划。", url: urls[0] },
    { text: "FAST 发布第二十六批科学数据。", url: urls[2] },
  ]);
  assert.deepEqual(selection.truncatedTexts, ["黄仁勋半年内第三次喊出"]);
});

// 2026-09-10 发到 20000001 的第一条播报就是这个形状：唯一的条目被截断。返回空列表，
// 调用方才会重试，而不是把「博客园作者」加一个链接发出去。
test("selectBroadcastItems returns no items when every item is truncated, so the caller retries", () => {
  const url = "https://www.cnblogs.com/janas/p/14897873.html";
  const selection = selectBroadcastItems([{ text: "博客园作者", url }], [url]);

  assert.deepEqual(selection.items, []);
  assert.deepEqual(selection.truncatedTexts, ["博客园作者"]);
});

test("selectBroadcastItems still rejects malformed items without counting them as truncated", () => {
  const url = "https://a.example/ok";
  const selection = selectBroadcastItems(
    [
      null,
      "not an object",
      { text: "链接不在候选列表里。", url: "https://invented.example/" },
      { text: "", url },
      { text: 42, url },
    ],
    [url],
  );

  assert.deepEqual(selection, { items: [], truncatedTexts: [] });
  assert.deepEqual(selectBroadcastItems(undefined, [url]), { items: [], truncatedTexts: [] });
});

// ---------- 只发最近 24 小时的内容 ----------

// 列表页条目的日期原文要原样带到核对那一步；没给的条目不凭空补一个空字段。
test("selectBroadcastItems carries each item's date evidence through", () => {
  const urls = ["https://leiphone.com/a/1", "https://36kr.com/p/2"];
  const selection = selectBroadcastItems(
    [
      { text: "雷锋网报道了新模型。", url: urls[0], date_evidence: " 09月11日 19:07 " },
      { text: "36氪报道了一笔融资。", url: urls[1], date_evidence: "" },
    ],
    urls,
  );

  assert.deepEqual(selection.items, [
    { text: "雷锋网报道了新模型。", url: urls[0], dateEvidence: "09月11日 19:07" },
    { text: "36氪报道了一笔融资。", url: urls[1] },
  ]);
});

test("the broadcast prompt tells the model the 24-hour window and which pages need a per-entry date", () => {
  const prompt = buildWorldObservationBroadcastPrompt(
    "人工智能",
    { query: "人工智能 最新 进展", summary: "[Browser observation] query=人工智能 最新 进展", urls: [] },
    [],
    {
      nowLabel: "2026-09-11 13:00",
      sinceLabel: "2026-09-10 13:00",
      pages: [
        { url: "https://36kr.com/p/1", kind: "recent-article", pageCitable: true },
        { url: "https://maomu.com/news", kind: "dated-listing", pageCitable: true },
        { url: "https://www.nasa.gov/news/", kind: "dated-listing", pageCitable: false },
      ],
    },
  );

  assert.ok(prompt.includes("It is now 2026-09-11 13:00 (Beijing time)"));
  assert.ok(prompt.includes("since 2026-09-10 13:00"));
  assert.ok(prompt.includes("- https://36kr.com/p/1 — an article published within the last 24 hours"));
  assert.ok(prompt.includes("- https://maomu.com/news — a listing/home page"));
  // 元数据说是旧页面的列表，只能引用它列出的条目链接。
  assert.match(prompt, /- https:\/\/www\.nasa\.gov\/news\/ — .*Cite the entry's own link, not this page\./);
  assert.doesNotMatch(prompt, /- https:\/\/maomu\.com\/news — .*Cite the entry's own link/);
  assert.ok(prompt.includes("Only include entries that are about the topic"));
  assert.ok(prompt.includes('"date_evidence": string'));
  assert.ok(prompt.includes("If nothing on these pages falls within the last 24 hours, return an empty items array."));
});

// 「数学」这个话题名太宽：Quanta 的数学频道里也有趣题专栏。范围说明要跟着话题进提示词。
test("the broadcast prompt carries a topic's scope only when one is configured", () => {
  const observation = { query: "数学 最新 进展", summary: "[Browser observation] query=数学 最新 进展", urls: [] };
  const freshness = { nowLabel: "2026-09-11 13:00", sinceLabel: "2026-09-10 13:00", pages: [] };
  const scope = "数学研究新闻与理论突破；不要趣味题和脑筋急转弯。";

  assert.ok(buildWorldObservationBroadcastPrompt("数学", observation, [], freshness, scope).includes(`topic: 数学\ntopic scope: ${scope}\n`));
  assert.ok(!buildWorldObservationBroadcastPrompt("数学", observation, [], freshness).includes("topic scope:"));
});
