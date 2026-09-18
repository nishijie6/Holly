import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSearchResultJudgePrompt,
  buildWorldObservationBroadcastPrompt,
  buildWorldObservationSharePrompt,
  isTruncatedBroadcastText,
  parseWorldObservationShareDecision,
  selectBroadcastItems,
  selectJudgedSearchResults,
} from "../autonomy-prompts.js";

const worldBlocks = [
  "World observation 1:\n- topic: 天文学\n- summary: 一些内容",
  "World observation 2:\n- topic: 数学趣题\n- summary: 另一些内容",
];
const churn = ["Internal memory 1:\n- content: 刚写下的记忆", "Recent conversation:\n- 有人说了句话"];

// The whole point of the split: two ticks that see the same world-observation
// window must produce byte-identical stable halves, or the cache entry the
// breakpoint creates is dead on arrival.
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
  // 一次播报最多 3 条，提示词里不能还写着 5。
  assert.ok(prompt.includes("items: at most 3 entries"));
  assert.ok(!/at most 5|beyond 5/.test(prompt));
});

// 「数学」这个话题名太宽：Quanta 的数学频道里也有趣题专栏。范围说明要跟着话题进提示词。
test("the broadcast prompt carries a topic's scope only when one is configured", () => {
  const observation = { query: "数学 最新 进展", summary: "[Browser observation] query=数学 最新 进展", urls: [] };
  const freshness = { nowLabel: "2026-09-11 13:00", sinceLabel: "2026-09-10 13:00", pages: [] };
  const scope = "数学研究新闻与理论突破；不要趣味题和脑筋急转弯。";

  assert.ok(buildWorldObservationBroadcastPrompt("数学", observation, [], freshness, scope).includes(`topic: 数学\ntopic scope: ${scope}\n`));
  assert.ok(!buildWorldObservationBroadcastPrompt("数学", observation, [], freshness).includes("topic scope:"));
});

// ---------- 打开网页前先筛搜索结果 ----------

// 2026-09-11「数学 最新 进展」的真实搜索结果。百度百科排在更前面，但已被域名黑名单挡掉，不会交给模型。
const MATH_SEARCH_RESULTS = [
  { title: "：网络上最全面的数学资源 - 数学天地", url: "https://mathworld.net.cn/", snippet: "2025年1月24日 · 由 Eric Weisstein 创建、开发和维护" },
  { title: "数学在线学习-高等数学/线性代数/概率论与数理统计在线学习", url: "https://kb.kmath.cn/kbase/", snippet: "初中数学还涉及统计与概率" },
  { title: "数学 | 可汗学院 - Khan Academy", url: "https://zh.khanacademy.org/math", snippet: "1 天前 · 欢迎来到可汗学院观看视频,做练习,提高你的数学技能." },
];

test("the search judge prompt numbers each result with its url and snippet, under the topic scope", () => {
  const prompt = buildSearchResultJudgePrompt({
    topic: "数学",
    topicBrief: "数学研究新闻与理论突破；不要趣味题。",
    nowLabel: "2026-09-11 17:00",
    sinceLabel: "2026-09-10 17:00",
    results: MATH_SEARCH_RESULTS,
  });

  assert.ok(prompt.includes("topic: 数学\ntopic scope: 数学研究新闻与理论突破；不要趣味题。"));
  assert.ok(prompt.includes("the window starts at 2026-09-10 17:00"));
  assert.ok(prompt.includes("3. 数学 | 可汗学院 - Khan Academy\n   url: https://zh.khanacademy.org/math\n   snippet: 1 天前"));
});

test("selectJudgedSearchResults drops what the model rejected and keeps everything else", () => {
  const results = [...MATH_SEARCH_RESULTS, { title: "Mathematics | Quanta Magazine", url: "https://www.quantamagazine.org/mathematics/", snippet: "" }];
  const selection = selectJudgedSearchResults({
    decisions: [
      { index: 1, keep: false, reason: " 数学资源站，不是新闻 " },
      { index: 2, keep: false, reason: "学习网站" },
      { index: 2, keep: true, reason: "同一编号判第二次，不算" },
      { index: 9, keep: false, reason: "编号越界" },
      { index: 4, keep: true, reason: "数学新闻列表" },
    ],
  }, results);

  // 模型没提到第 3 条：拿不准就留下，后面还有日期闸门。
  assert.deepEqual(selection?.kept.map((result) => result.url), [
    "https://zh.khanacademy.org/math",
    "https://www.quantamagazine.org/mathematics/",
  ]);
  assert.deepEqual(selection?.dropped.map(({ result, reason }) => [result.url, reason]), [
    ["https://mathworld.net.cn/", "数学资源站，不是新闻"],
    ["https://kb.kmath.cn/kbase/", "学习网站"],
  ]);
});

test("selectJudgedSearchResults returns null when nothing in the reply is usable, so the caller does not screen", () => {
  for (const raw of [undefined, null, "keep all", {}, { decisions: [] }, { decisions: [{ index: "1", keep: false }, { index: 1 }] }]) {
    assert.equal(selectJudgedSearchResults(raw, MATH_SEARCH_RESULTS), null, JSON.stringify(raw));
  }
});

test("发不发的提示词带着话题、群里最近的聊天、冷场时长，成稿原样放在最后", () => {
  const draft = "詹姆斯·韦布望远镜发现一颗新的系外行星。 https://example.com/b";
  const prompt = buildWorldObservationSharePrompt({
    topic: "天文学",
    nowLabel: "2026-09-14 20:00",
    groupId: "20000001",
    idleMinutes: 95,
    recentTurns: [
      { timestamp: "2026-09-14T10:20:00.000Z", speaker: "Holly", content: "1. 韦布望远镜拍到新图像。 https://example.com/a" },
      { timestamp: "2026-09-14T10:25:00.000Z", speaker: "小明(10001)", content: "今晚有人打游戏吗" },
    ],
    draft,
  });

  assert.match(prompt, /「天文学」/);
  assert.match(prompt, /群 20000001/);
  assert.match(prompt, /现在是 2026-09-14 20:00/);
  assert.match(prompt, /群里最后一条消息在 95 分钟前/);
  assert.match(prompt, /- \[2026-09-14T10:20:00\.000Z\] Holly: 1\. 韦布望远镜拍到新图像。/);
  assert.match(prompt, /- \[2026-09-14T10:25:00\.000Z\] 小明\(10001\): 今晚有人打游戏吗/);
  assert.match(prompt, /"send"/);
  assert.ok(prompt.endsWith(`准备发出的消息：\n${draft}`));
});

test("查不到群里动静时，发不发的提示词如实说不清楚，而不是编一个冷场时长", () => {
  const prompt = buildWorldObservationSharePrompt({
    topic: "数学",
    nowLabel: "2026-09-14 20:00",
    groupId: "20000002",
    idleMinutes: null,
    recentTurns: [],
    draft: "陶哲轩团队公布了新证明。 https://example.com/c",
  });

  assert.match(prompt, /群里最后一条消息是什么时候：不清楚/);
  assert.match(prompt, /\(没有记录\)/);
});

test("parseWorldObservationShareDecision 只认真正的布尔表态，其余一律当没表态", () => {
  assert.deepEqual(parseWorldObservationShareDecision({ send: false, reason: " 进展太小 " }), { send: false, reason: "进展太小" });
  assert.deepEqual(parseWorldObservationShareDecision({ send: true }), { send: true, reason: "" });
  for (const raw of [undefined, null, "send", [], {}, { send: "true", reason: "字符串不算" }, { send: 1 }]) {
    assert.equal(parseWorldObservationShareDecision(raw), null, JSON.stringify(raw));
  }
});
