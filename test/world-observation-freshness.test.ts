import assert from "node:assert/strict";
import test from "node:test";

import {
  beijingDateKey,
  classifyBroadcastSources,
  findRecentDateMarkers,
  freshnessWindowLabels,
  isBroadcastItemFresh,
  parsePublishedAt,
} from "../world-observation-freshness.js";

// 北京时间 2026-09-11 13:00，窗口从 2026-09-10 13:00 开始。
const NOON = Date.parse("2026-09-11T05:00:00Z");

function hasRecent(text: string, now = NOON): boolean {
  return findRecentDateMarkers(text, now).length > 0;
}

// 前三种取自真实页面：36kr 的 meta、腾讯新闻不带时区的 meta、博客园 JSON-LD 里转义过的 +。
test("parsePublishedAt reads the publish-time formats real news pages declare", () => {
  const cases: Array<[string, string, boolean]> = [
    ["2026-09-11T14:00:15+08:00", "2026-09-11T06:00:15Z", true],
    ["2026-08-02 17:00:59", "2026-08-02T09:00:59Z", true],
    ["2021-06-14T20:30:00.0000000&#x2B;08:00", "2021-06-14T12:30:00Z", true],
    ["2026-09-11 14:00:15 +0800", "2026-09-11T06:00:15Z", true],
    ["2026年09月11日 14:00", "2026-09-11T06:00:00Z", true],
    ["2026年9月10号 16:23", "2026-09-10T08:23:00Z", true],
    ["2026/9/11", "2026-09-10T16:00:00Z", false],
    ["1789106415", "2026-09-11T06:00:15Z", true],
    ["1789106415000", "2026-09-11T06:00:15Z", true],
    ["Fri, 11 Sep 2026 06:00:15 GMT", "2026-09-11T06:00:15Z", true],
  ];
  for (const [raw, iso, hasTime] of cases) {
    assert.deepEqual(parsePublishedAt(raw), { ms: Date.parse(iso), hasTime }, raw);
  }
});

test("parsePublishedAt rejects values that are not a real date", () => {
  for (const raw of ["", "刚刚", "2026-02-30", "2026-13-01 10:00", "Sep 11"]) {
    assert.equal(parsePublishedAt(raw), null, raw);
  }
});

test("dates are cut on Beijing time, and the window is labelled in Beijing time", () => {
  assert.equal(beijingDateKey(Date.parse("2026-09-10T16:30:00Z")), "2026-09-11");
  assert.deepEqual(freshnessWindowLabels(NOON), { now: "2026-09-11 13:00", since: "2026-09-10 13:00" });
});

// 片段取自真实列表页：猫目、雷锋网、aibase、量子位、国家天文台、51CTO、phys.org、Space.com、Quanta。
test("findRecentDateMarkers recognizes how listing pages date their entries", () => {
  assert.equal(hasRecent("24小时AI快讯 今日 - 2026-09-11 声音提醒 开 关 12:37 中国软件协会"), true);
  assert.equal(hasRecent("通关 AGI 了？ 高允毅 09月11日 10:07 GPT-6 Astra"), true);
  assert.equal(hasRecent("往期日报~ 2026年9月11号 11:10AI 日报"), true);
  // 时间后面跟着英文名字，不能把「Z」当成 UTC 时区。
  assert.equal(hasRecent("新闻 09-11 10:30 Zhang San 报道"), true);
  assert.equal(hasRecent("进入真实投研工作流 量子位 7小时前 SkyProduction"), true);
  assert.equal(hasRecent("作者 刚刚 标题"), true);
  assert.equal(hasRecent("Astronomers spot a new comet 11 hours ago"), true);
  assert.equal(hasRecent("Webb finds water Sep 10, 2026"), true);
  assert.equal(hasRecent("Rocket launch Sept. 11, 2026"), true);
  assert.equal(hasRecent("A new proof September 11, 2026"), true);
  // 24 小时是滑动的：昨天下午的条目仍在窗口里，昨天上午的已经出去了。
  assert.equal(hasRecent("成本大洗牌。 郑佳美 昨天 15:00 CED架构"), true);
  assert.equal(hasRecent("FAST绘就最大宇宙气体图谱 09-10 中国科学家领衔"), true);
  assert.equal(hasRecent("高允毅 昨天 09:00 旧闻"), false);
  assert.equal(hasRecent("AI 运维 2026-09-10 09:42:27 智能运维"), false);

  assert.equal(hasRecent("图谱 09-08 中国科学家"), false);
  assert.equal(hasRecent("开源大模型 2025-09-11 09:00:31 来源：人民邮电报"), false);
  assert.equal(hasRecent("刚刚，OpenAI 发布了新模型"), false);
  assert.equal(hasRecent("An older piece 30 hours ago"), false);
  assert.equal(hasRecent("A new proof September 8, 2026"), false);
});

// 窗口是滑动的，凌晨照样能认出前一晚的条目——按日历切的「今天」在这个时刻什么都认不出。
test("findRecentDateMarkers still finds last night's entries in the early morning", () => {
  const oneAm = Date.parse("2026-09-10T17:00:00Z");
  assert.equal(hasRecent("量子位 7小时前", oneAm), true);
  assert.equal(hasRecent("2026年09月10日 22:00 发布会", oneAm), true);
  // <time datetime> 补进正文的 UTC 时间按它自己的时区算：20:00Z 是北京时间次日 04:00，还没到。
  assert.equal(hasRecent("Sept. 10, 2026 2026-09-10T20:00:00Z", oneAm), true);
});

// 上海天文台首页顶上挂着「2026年9月11日 星期五」，底下的新闻却是 9 月 7 日的。
test("findRecentDateMarkers ignores page-header clocks that show the weekday", () => {
  assert.deepEqual(findRecentDateMarkers("2026年9月11日 星期五 恒星的迟暮与未尽的氢海 2026-09-07", NOON), []);
  assert.deepEqual(findRecentDateMarkers("2026-09-11 周五 首页", NOON), []);
  assert.deepEqual(findRecentDateMarkers("Friday, September 11, 2026 Home", NOON), []);
});

test("classifyBroadcastSources tells articles from listings, and says why the rest were dropped", () => {
  const { sources, rejected } = classifyBroadcastSources([
    { url: "https://36kr.com/p/1", excerpt: "正文 2026年09月11日 11:47", publishedAt: "2026-09-11T11:47:00+08:00" },
    // 元数据说是旧稿，正文里就算出现今天的日期也不要。
    { url: "https://news.qq.com/a/2", excerpt: "正文 2026-09-11", publishedAt: "2026-08-02 17:00:59" },
    // 36氪 AI 频道：渲染后带着今天的元数据，但它是列表，要逐条核对。
    {
      url: "https://36kr.com/information/AI/",
      excerpt: "标题一 17分钟前 标题二 1小时前 标题三 昨天 20:00",
      publishedAt: "2026-09-11T13:00:00+08:00",
    },
    // NASA 新闻列表：全站通用的旧元数据，列表里却有昨天的条目。
    {
      url: "https://www.nasa.gov/news/",
      excerpt: "Moon Sep 10, 2026 Mars Sep 9, 2026 Jupiter Sep 8, 2026",
      publishedAt: "2022-12-08",
    },
    { url: "https://qw.91maths.com/xl/112.html", excerpt: "用8个数字8如何组合等于1000" },
    { url: "https://down.example.com", excerpt: "", error: "net::ERR_CONNECTION_RESET" },
  ], NOON);

  assert.deepEqual(
    sources.map((source) => [source.page.url, source.kind, source.pageCitable]),
    [
      ["https://36kr.com/p/1", "recent-article", true],
      ["https://36kr.com/information/AI/", "dated-listing", true],
      ["https://www.nasa.gov/news/", "dated-listing", false],
    ],
  );
  assert.deepEqual(rejected, [
    { url: "https://news.qq.com/a/2", reason: "published=2026-08-02" },
    { url: "https://qw.91maths.com/xl/112.html", reason: "no publish date, and no date from the last 24 hours on the page" },
  ]);
});

test("isBroadcastItemFresh requires a listing entry to quote a recent date, time included, from that same page", () => {
  const article = { url: "https://36kr.com/p/1", excerpt: "正文 2026年09月11日 11:47", publishedAt: "2026-09-11T11:47:00+08:00" };
  const listing = {
    url: "https://leiphone.com/category/ai",
    excerpt: "新闻甲 09-11 10:30 新闻乙 09-10 09:00 新闻丙 09-10 20:00",
    links: [{ url: "https://leiphone.com/a/1" }, { url: "https://leiphone.com/a/2" }, { url: "https://leiphone.com/a/3" }],
  };
  const { sources } = classifyBroadcastSources([article, listing], NOON);

  assert.equal(isBroadcastItemFresh({ url: article.url }, sources, NOON), true);
  assert.equal(isBroadcastItemFresh({ url: "https://leiphone.com/a/1", dateEvidence: "09-11 10:30" }, sources, NOON), true);
  assert.equal(isBroadcastItemFresh({ url: "https://leiphone.com/a/3", dateEvidence: "09-10 20:00" }, sources, NOON), true);
  // 模型抄的时候吞掉空格也认。
  assert.equal(isBroadcastItemFresh({ url: "https://leiphone.com/a/3", dateEvidence: "09-1020:00" }, sources, NOON), true);

  // 昨天上午的条目已出窗口；只抄日期不抄时间，也替它蒙混不过去。
  assert.equal(isBroadcastItemFresh({ url: "https://leiphone.com/a/2", dateEvidence: "09-10 09:00" }, sources, NOON), false);
  assert.equal(isBroadcastItemFresh({ url: "https://leiphone.com/a/2", dateEvidence: "09-10" }, sources, NOON), false);
  assert.equal(isBroadcastItemFresh({ url: "https://leiphone.com/a/1", dateEvidence: "" }, sources, NOON), false);
  assert.equal(isBroadcastItemFresh({ url: "https://elsewhere.example.com", dateEvidence: "09-11 10:30" }, sources, NOON), false);
});

test("isBroadcastItemFresh only lets a listing with stale metadata be cited through its entry links", () => {
  const nasa = {
    url: "https://www.nasa.gov/news/",
    excerpt: "Moon Sep 10, 2026 Mars Sep 9, 2026 Jupiter Sep 8, 2026",
    publishedAt: "2022-12-08",
    links: [{ url: "https://www.nasa.gov/news/moon" }],
  };
  const { sources } = classifyBroadcastSources([nasa], NOON);

  assert.equal(isBroadcastItemFresh({ url: "https://www.nasa.gov/news/moon", dateEvidence: "Sep 10, 2026" }, sources, NOON), true);
  assert.equal(isBroadcastItemFresh({ url: "https://www.nasa.gov/news/", dateEvidence: "Sep 10, 2026" }, sources, NOON), false);
});

test("isBroadcastItemFresh does not let a page-header clock or another year's date stand in for an entry's date", () => {
  const home = {
    url: "https://shao.ac.cn",
    excerpt: "2026年9月11日 星期五 恒星的迟暮 2026-09-07 开放日报名 今天 10:30 往年回顾 2025-09-11",
    links: [{ url: "https://shao.ac.cn/a/open-day" }],
  };
  const { sources } = classifyBroadcastSources([home], NOON);

  assert.equal(isBroadcastItemFresh({ url: "https://shao.ac.cn/a/open-day", dateEvidence: "2026年9月11日" }, sources, NOON), false);
  assert.equal(isBroadcastItemFresh({ url: "https://shao.ac.cn/a/open-day", dateEvidence: "09-11" }, sources, NOON), false);
  assert.equal(isBroadcastItemFresh({ url: "https://shao.ac.cn/a/open-day", dateEvidence: "今天 10:30" }, sources, NOON), true);
});
