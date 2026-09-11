import assert from "node:assert/strict";
import test from "node:test";

import { planBrowseCandidates } from "../browser-agent.js";

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
