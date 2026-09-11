import assert from "node:assert/strict";
import test from "node:test";

import {
  beijingDateKey,
  classifyBroadcastSources,
  findTodayDateMarkers,
  isBroadcastItemFresh,
  parsePublishedAtMs,
  publishedDateKey,
} from "../world-observation-freshness.js";

// 北京时间 2026-09-11 13:00。
const NOON = Date.parse("2026-09-11T05:00:00Z");

function hasToday(text: string, now = NOON): boolean {
  return findTodayDateMarkers(text, now).length > 0;
}

// 前三种取自真实页面：36kr 的 meta、腾讯新闻不带时区的 meta、博客园 JSON-LD 里转义过的 +。
test("parsePublishedAtMs reads the publish-time formats real news pages declare", () => {
  assert.equal(parsePublishedAtMs("2026-09-11T14:00:15+08:00"), Date.parse("2026-09-11T06:00:15Z"));
  assert.equal(parsePublishedAtMs("2026-08-02 17:00:59"), Date.parse("2026-08-02T09:00:59Z"));
  assert.equal(parsePublishedAtMs("2021-06-14T20:30:00.0000000&#x2B;08:00"), Date.parse("2021-06-14T12:30:00Z"));
  assert.equal(parsePublishedAtMs("2026-09-11T06:00:15Z"), Date.parse("2026-09-11T06:00:15Z"));
  assert.equal(parsePublishedAtMs("2026-09-11 14:00:15 +0800"), Date.parse("2026-09-11T06:00:15Z"));
  assert.equal(parsePublishedAtMs("2026年09月11日 14:00"), Date.parse("2026-09-11T06:00:00Z"));
  assert.equal(parsePublishedAtMs("2026年9月10号 16:23"), Date.parse("2026-09-10T08:23:00Z"));
  assert.equal(parsePublishedAtMs("2026/9/11"), Date.parse("2026-09-10T16:00:00Z"));
  assert.equal(parsePublishedAtMs("1789106415"), Date.parse("2026-09-11T06:00:15Z"));
  assert.equal(parsePublishedAtMs("1789106415000"), Date.parse("2026-09-11T06:00:15Z"));
  assert.equal(parsePublishedAtMs("Fri, 11 Sep 2026 06:00:15 GMT"), Date.parse("2026-09-11T06:00:15Z"));
});

test("parsePublishedAtMs rejects values that are not a real date", () => {
  assert.equal(parsePublishedAtMs(""), null);
  assert.equal(parsePublishedAtMs("刚刚"), null);
  assert.equal(parsePublishedAtMs("2026-02-30"), null);
  assert.equal(parsePublishedAtMs("2026-13-01 10:00"), null);
  // Date.parse 会把「Sep 11」猜成 2001 年，没有四位年份的英文日期不接。
  assert.equal(parsePublishedAtMs("Sep 11"), null);
});

// UTC 16:00 在北京已经是第二天，按 UTC 切日子会把凌晨发的新闻算成昨天。
test("publishedDateKey cuts days on Beijing time, not UTC", () => {
  assert.equal(beijingDateKey(Date.parse("2026-09-10T16:30:00Z")), "2026-09-11");
  assert.equal(publishedDateKey("2026-09-11 00:05:00"), "2026-09-11");
  assert.equal(publishedDateKey("2026-09-10T16:10:00Z"), "2026-09-11");
  assert.equal(publishedDateKey("2026-09-10T23:59:00+08:00"), "2026-09-10");
  assert.equal(publishedDateKey(undefined), null);
  assert.equal(publishedDateKey("not a date"), null);
});

// 片段取自 2026-09-10、09-11 真实抓到的猫目、雷锋网、aibase、量子位、国家天文台、新华网。
test("findTodayDateMarkers recognizes how listing pages date their entries", () => {
  assert.equal(hasToday("24小时AI快讯 今日 - 2026-09-11 声音提醒 开 关 12:37 中国软件协会"), true);
  assert.equal(hasToday("通关 AGI 了？ 高允毅 09月11日 19:07 GPT-6 Astra"), true);
  assert.equal(hasToday("往期日报~ 2026年9月11号 16:10AI 日报"), true);
  assert.equal(hasToday("进入真实投研工作流 量子位 7小时前 SkyProduction"), true);
  assert.equal(hasToday("作者 刚刚 标题"), true);

  assert.equal(hasToday("成本大洗牌。 高允毅 昨天 19:00 CED架构"), false);
  assert.equal(hasToday("FAST绘就最大宇宙气体图谱 09-08 中国科学家领衔"), false);
  assert.equal(hasToday("开源大模型 2025-09-11 09:00:31 来源：人民邮电报"), false);
  assert.equal(hasToday("刚刚，OpenAI 发布了新模型"), false);
  // 北京时间凌晨 1 点，「7小时前」已经是昨天。
  assert.equal(hasToday("量子位 7小时前", Date.parse("2026-09-10T17:00:00Z")), false);
});

// 上海天文台首页顶上挂着「2026年9月11日 星期五」，底下的新闻却是 9 月 7 日的。
test("findTodayDateMarkers ignores a page-header clock that shows today's weekday", () => {
  assert.deepEqual(findTodayDateMarkers("2026年9月11日 星期五 恒星的迟暮与未尽的氢海 2026-09-07", NOON), []);
  assert.deepEqual(findTodayDateMarkers("2026-09-11 周五 首页", NOON), []);
});

test("classifyBroadcastSources keeps today's articles and dated listing pages, and says why the rest were dropped", () => {
  const { sources, rejected } = classifyBroadcastSources([
    { url: "https://36kr.com/p/1", excerpt: "正文", publishedAt: "2026-09-11T14:08:53+08:00" },
    { url: "https://news.qq.com/a/2", excerpt: "正文 2026-09-11", publishedAt: "2026-08-02 17:00:59" },
    { url: "https://maomu.com/news", excerpt: "今日 - 2026-09-11 12:37 中国软件协会回应" },
    { url: "https://qw.91maths.com/xl/112.html", excerpt: "用8个数字8如何组合等于1000" },
    { url: "https://down.example.com", excerpt: "", error: "net::ERR_CONNECTION_RESET" },
  ], NOON);

  assert.deepEqual(
    sources.map((source) => [source.page.url, source.kind]),
    [["https://36kr.com/p/1", "article-today"], ["https://maomu.com/news", "dated-listing"]],
  );
  // 元数据说是旧稿的页面，正文里就算出现今天的日期也不要。
  assert.deepEqual(rejected, [
    { url: "https://news.qq.com/a/2", reason: "published=2026-08-02" },
    { url: "https://qw.91maths.com/xl/112.html", reason: "no publish date, and no date of today on the page" },
  ]);
});

test("isBroadcastItemFresh requires a listing-page entry to quote a date of today from that same page", () => {
  const article = { url: "https://36kr.com/p/1", excerpt: "正文", publishedAt: "2026-09-11T14:08:53+08:00" };
  const listing = {
    url: "https://leiphone.com/category/ai",
    excerpt: "GPT-6 Astra 符号世界 高允毅 09月11日 19:07 微软小冰，生不逢时 郑佳美 昨天 15:00",
    links: [{ url: "https://leiphone.com/a/today" }, { url: "https://leiphone.com/a/yesterday" }],
  };
  const { sources } = classifyBroadcastSources([article, listing], NOON);

  assert.equal(isBroadcastItemFresh({ url: article.url }, sources, NOON), true);
  assert.equal(isBroadcastItemFresh({ url: "https://leiphone.com/a/today", dateEvidence: "09月11日 19:07" }, sources, NOON), true);
  // 模型抄的时候吞掉空格也认。
  assert.equal(isBroadcastItemFresh({ url: "https://leiphone.com/a/today", dateEvidence: "09月11日19:07" }, sources, NOON), true);

  // 日期原文页面上没有、写的是昨天、或者干脆没给，都不放。
  assert.equal(isBroadcastItemFresh({ url: "https://leiphone.com/a/yesterday", dateEvidence: "09月11日 15:00" }, sources, NOON), false);
  assert.equal(isBroadcastItemFresh({ url: "https://leiphone.com/a/yesterday", dateEvidence: "昨天 15:00" }, sources, NOON), false);
  assert.equal(isBroadcastItemFresh({ url: "https://leiphone.com/a/today", dateEvidence: "" }, sources, NOON), false);
  // 今天的文章页只放行它自己，链接不属于任何一页也不放。
  assert.equal(isBroadcastItemFresh({ url: "https://elsewhere.example.com", dateEvidence: "09月11日 19:07" }, sources, NOON), false);
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
