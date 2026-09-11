import assert from "node:assert/strict";
import test from "node:test";

import { planBrowseCandidates, screenSearchResults } from "../browser-agent.js";

// 固定来源每轮都读，不能和搜索结果抢那几个名额。
test("planBrowseCandidates puts fixed sources first and gives them their own page budget", () => {
  const plan = planBrowseCandidates(
    ["https://www.qbitai.com/", " https://36kr.com/information/AI/ ", "https://www.qbitai.com/"],
    ["https://maomu.com/news", "https://www.qbitai.com/", "https://www.aibase.com/zh/daily"],
    3,
  );

  assert.deepEqual(plan.urls, [
    "https://www.qbitai.com/",
    "https://36kr.com/information/AI/",
    "https://maomu.com/news",
    "https://www.aibase.com/zh/daily",
  ]);
  assert.equal(plan.maxPages, 5);
});

test("planBrowseCandidates leaves a topic without fixed sources as it was", () => {
  assert.deepEqual(
    planBrowseCandidates([], ["https://a.example/", "https://b.example/"], 3),
    { urls: ["https://a.example/", "https://b.example/"], maxPages: 3 },
  );
});

const SEARCH_RESULTS = [
  { title: "数学（学科）_百度百科", url: "https://baike.baidu.com/item/数学", snippet: "" },
  { title: "数学天地", url: "https://mathworld.net.cn/", snippet: "" },
  { title: "某篇论文", url: "https://example.com/paper.pdf", snippet: "" },
  { title: "Mathematics | Quanta Magazine", url: "https://www.quantamagazine.org/mathematics/", snippet: "" },
];

test("screenSearchResults keeps blocked domains and PDFs away from the judge, and opens only what it keeps", async () => {
  const shown: string[][] = [];
  const urls = await screenSearchResults(SEARCH_RESULTS, async (results) => {
    shown.push(results.map((result) => result.url));
    return results.filter((result) => result.url.includes("quantamagazine"));
  });

  assert.deepEqual(shown, [["https://mathworld.net.cn/", "https://www.quantamagazine.org/mathematics/"]]);
  assert.deepEqual(urls, ["https://www.quantamagazine.org/mathematics/"]);
});

// 判断只是省几次页面加载，它出错不能拖垮整轮观察。
test("screenSearchResults opens every openable result when the judge fails", async () => {
  const errors: unknown[] = [];
  const urls = await screenSearchResults(
    SEARCH_RESULTS,
    async () => {
      throw new Error("model unavailable");
    },
    (error) => errors.push(error),
  );

  assert.deepEqual(urls, ["https://mathworld.net.cn/", "https://www.quantamagazine.org/mathematics/"]);
  assert.equal(errors.length, 1);
});
