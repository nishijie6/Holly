import assert from "node:assert/strict";
import test from "node:test";

import { isSafeExternalPageUrl, planBrowseCandidates, resolvesToPublicAddress, screenSearchResults } from "../browser-agent.js";
import * as browserAgent from "../browser-agent.js";

test("observation availability follows the actual browser/search route, including a fixed daily leaderboard", () => {
  assert.equal(typeof browserAgent.canBrowseTopicWithBrowserAgent, "function");
  assert.equal(browserAgent.canBrowseTopicWithBrowserAgent({ enabled: true }, true, []), true);
  assert.equal(browserAgent.canBrowseTopicWithBrowserAgent({ enabled: false }, true, []), false);
  assert.equal(browserAgent.canBrowseTopicWithBrowserAgent({ enabled: true }, false, []), false);
  assert.equal(browserAgent.canBrowseTopicWithBrowserAgent({ enabled: true }, false, ["https://github.com/trending?since=daily"]), true);
  assert.equal(browserAgent.canBrowseTopicWithBrowserAgent({ enabled: true }, false, ["https://example.com/news"]), false);
});

// read_page 的 URL 是模型自己写的，会直接进浏览器。这台机器上 SearxNG、NapCat、Qdrant
// 都在本地端口听着，一个内网地址就能把自家后台读出来发进群，所以这道闸只放行公网网页。
test("isSafeExternalPageUrl 只放行公网 http/https", () => {
  for (const url of [
    "https://www.quantamagazine.org/mathematics/",
    "http://example.com/a?b=1",
  ]) {
    assert.equal(isSafeExternalPageUrl(url), true, `${url} 该放行`);
  }
  for (const url of [
    "http://127.0.0.1:8888/search?q=x",
    "http://localhost:3000/",
    "http://192.168.1.10/admin",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]:6333/collections",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]:8888/",
    "http://[fe80::1]/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://foo.localhost/",
    "http://napcat.local/",
    "file:///path/to/Holly/.env",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "不是个网址",
    "",
  ]) {
    assert.equal(isSafeExternalPageUrl(url), false, `${url} 该拦下`);
  }
});

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

test("resolvesToPublicAddress 拦下字面内网 IP，放行公网 IP 字面量", async () => {
  assert.equal(await resolvesToPublicAddress("http://127.0.0.1:8888/"), false);
  assert.equal(await resolvesToPublicAddress("http://[::ffff:127.0.0.1]/"), false);
  assert.equal(await resolvesToPublicAddress("http://8.8.8.8/"), true);
});

function fakeIpDns(addresses = ["198.18.0.133"], a = ["93.184.215.14"], aaaa: string[] = []) {
  const queries: string[] = [];
  const fetchDns: typeof fetch = async (input) => {
    const query = new URL(String(input));
    queries.push(`${query.searchParams.get("name")}:${query.searchParams.get("type")}`);
    const type = query.searchParams.get("type") === "A" ? 1 : 28;
    return Response.json({ Status: 0, TC: false, Answer: (type === 1 ? a : aaaa).map((data) => ({ type, data })) });
  };
  return { lookup: async () => addresses.map((address) => ({ address })), fetch: fetchDns, queries };
}

test("resolvesToPublicAddress 用真实 A/AAAA 结果校验代理 Fake-IP 域名", async () => {
  const dns = fakeIpDns();
  assert.equal(await resolvesToPublicAddress("https://example.com/", dns), true);
  assert.deepEqual(dns.queries.sort(), ["example.com:A", "example.com:AAAA"]);
});

test("resolvesToPublicAddress 真实 DNS 的 CNAME 和公网 IPv6 可以正常读取", async () => {
  const dns = fakeIpDns(undefined, [], ["2606:4700:4700::1111"]);
  const fetchDns = dns.fetch;
  dns.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).origin, "https://dns.alidns.com");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const response = await fetchDns(input, init);
    const body = await response.json();
    body.Answer.unshift({ type: 5, data: "cdn.example.com." });
    return Response.json(body);
  };
  assert.equal(await resolvesToPublicAddress("https://example.com/", dns), true);
});

test("resolvesToPublicAddress 本地 DNS 空结果或失败时不走 Fake-IP 回查", async () => {
  const dns = fakeIpDns([]);
  assert.equal(await resolvesToPublicAddress("https://example.com/", dns), false);
  dns.lookup = async () => { throw new Error("ENOTFOUND"); };
  assert.equal(await resolvesToPublicAddress("https://example.com/", dns), false);
  assert.deepEqual(dns.queries, []);
});

test("resolvesToPublicAddress 普通公网 DNS 结果不额外查询", async () => {
  const dns = fakeIpDns(["93.184.215.14", "2606:4700:4700::1111"]);
  assert.equal(await resolvesToPublicAddress("https://example.com/", dns), true);
  assert.deepEqual(dns.queries, []);
});

test("resolvesToPublicAddress 不让 Fake-IP 掩盖本地 DNS 中的内网地址", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "::1", "198.19.0.1", "invalid"]) {
    const dns = fakeIpDns(["198.18.0.133", address]);
    assert.equal(await resolvesToPublicAddress("https://example.com/", dns), false, address);
    assert.deepEqual(dns.queries, []);
  }
});

test("resolvesToPublicAddress Fake-IP 的真实 DNS 中有内网地址仍然拒绝", async () => {
  for (const dns of [
    fakeIpDns(undefined, ["93.184.215.14", "127.0.0.1"]),
    fakeIpDns(undefined, undefined, ["::1"]),
    fakeIpDns(undefined, undefined, ["::ffff:7f00:1"]),
    fakeIpDns(undefined, ["198.18.0.10"]),
  ]) {
    assert.equal(await resolvesToPublicAddress("https://example.com/", dns), false);
    assert.equal(dns.queries.length, 2);
  }
});

test("resolvesToPublicAddress 真实 DNS 失败、截断、空结果或无效地址时拒绝", async () => {
  const bodies: unknown[] = [
    { Status: 2 },
    { Status: 0, TC: true, Answer: [{ type: 1, data: "93.184.215.14" }] },
    { Status: 0, Answer: [] },
    { Status: 0, Answer: [{ type: 1, data: "invalid" }] },
    { Status: 0, Answer: [{ type: 1, data: "::1" }] },
    { Status: 0, Answer: "malformed" },
  ];
  for (const body of bodies) {
    const dns = fakeIpDns();
    dns.fetch = async () => Response.json(body);
    assert.equal(await resolvesToPublicAddress("https://example.com/", dns), false);
  }
  for (const fetchDns of [
    async () => { throw new Error("DNS timeout"); },
    async () => new Response("unavailable", { status: 503 }),
  ]) {
    assert.equal(await resolvesToPublicAddress("https://example.com/", { ...fakeIpDns(), fetch: fetchDns }), false);
  }
});

test("resolvesToPublicAddress 字面 Fake-IP 不走真实 DNS 放行", async () => {
  const dns = fakeIpDns();
  assert.equal(await resolvesToPublicAddress("http://198.18.0.133/", dns), false);
  assert.equal(await resolvesToPublicAddress("http://198.19.0.133/", dns), false);
  assert.deepEqual(dns.queries, []);
});
