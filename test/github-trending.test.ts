import assert from "node:assert/strict";
import test from "node:test";

import {
  formatGitHubTrendingRepositories,
  isGitHubTrendingSourceList,
  isGitHubTrendingUrl,
} from "../github-trending.js";

test("only GitHub's daily repository leaderboard bypasses web search", () => {
  for (const url of [
    "https://github.com/trending",
    "https://github.com/trending/?since=daily",
    "https://github.com/trending?since=daily&spoken_language_code=zh",
  ]) {
    assert.equal(isGitHubTrendingUrl(url), true, url);
  }
  for (const url of [
    "https://github.com/trending?since=weekly",
    "https://github.com/trending/developers",
    "https://github.com/owner/repo",
    "https://github.com.example.com/trending",
    "https://example.com/trending",
    "https://user:password@github.com/trending",
    "http://github.com/trending",
    "not a URL",
  ]) {
    assert.equal(isGitHubTrendingUrl(url), false, url);
  }
  assert.equal(isGitHubTrendingSourceList(["https://github.com/trending?since=daily"]), true);
  assert.equal(isGitHubTrendingSourceList([]), false);
  assert.equal(isGitHubTrendingSourceList([
    "https://github.com/trending?since=daily",
    "https://example.com/news",
  ]), false);
});

test("a daily snapshot labels repository facts and cites each repository", () => {
  const page = formatGitHubTrendingRepositories([
    {
      url: "https://github.com/acme/local-agent",
      description: "  Runs agents\n on your computer. ",
      language: "TypeScript",
      stars: " 12,345 ",
      starsToday: " 678 stars today ",
    },
    {
      url: "https://github.com/research/solver?from=trending#readme",
      description: "A mathematical solver.",
      language: "Python",
      stars: "9,876",
      starsToday: "321 stars today",
    },
  ], "https://github.com/trending?since=daily");

  assert.match(page.text, /今日热度.*不代表项目今天发布/);
  assert.match(page.text, /1\. acme\/local-agent/);
  assert.match(page.text, /Runs agents on your computer\./);
  assert.match(page.text, /Language: TypeScript/);
  assert.match(page.text, /Stars: 12,345/);
  assert.match(page.text, /Stars today: 678/);
  assert.match(page.text, /2\. research\/solver/);
  assert.match(page.text, /https:\/\/github\.com\/research\/solver/);
  assert.deepEqual(page.links, [
    { text: "acme/local-agent", url: "https://github.com/acme/local-agent" },
    { text: "research/solver", url: "https://github.com/research/solver" },
  ]);
});

test("navigation links, invalid cards and duplicate repositories cannot become projects", () => {
  const page = formatGitHubTrendingRepositories([
    null,
    { url: "https://github.com/trending?spoken_language_code=ab" },
    { url: "https://github.com/acme/tool/stargazers" },
    { url: "https://example.com/acme/tool" },
    { url: "https://github.com/acme/tool", description: "A tool." },
    { url: "https://github.com/acme/tool#readme", description: "Duplicate." },
  ], "https://github.com/trending?since=daily");

  assert.deepEqual(page.links, [{ text: "acme/tool", url: "https://github.com/acme/tool" }]);
  assert.doesNotMatch(page.text, /Duplicate|spoken_language_code|undefined/);
  assert.doesNotMatch(page.text, /Stars: 0|Language: undefined/);
  for (const empty of [[], null, {}, [{ url: "invalid" }]]) {
    assert.deepEqual(formatGitHubTrendingRepositories(empty, "https://github.com/trending?since=daily"), { text: "", links: [] });
  }
});

test("a redirect away from the daily leaderboard cannot produce a daily snapshot", () => {
  const cards = [{ url: "https://github.com/acme/tool", description: "A tool.", starsToday: "12 stars today" }];
  for (const finalUrl of [
    "https://github.com/login?return_to=%2Ftrending",
    "https://github.com/trending?since=weekly",
    "https://example.com/trending?since=daily",
  ]) {
    assert.deepEqual(formatGitHubTrendingRepositories(cards, finalUrl), { text: "", links: [] });
  }
});
