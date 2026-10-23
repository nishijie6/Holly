import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAutonomyContext, type AutonomyContextInput } from "../autonomy-context.js";

const NOW = Date.parse("2026-10-21T08:00:00+08:00");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function input(overrides: Partial<AutonomyContextInput> = {}): AutonomyContextInput {
  return {
    nowMs: NOW,
    lastAutonomousMessageAt: 0,
    lastWorldObservationAt: 0,
    lastWorldObservationShareAt: 0,
    recentActions: [],
    worldObservationEnabled: true,
    topics: [],
    ...overrides,
  };
}

test("context distinguishes a real autonomous send from an observation share or a missing record", () => {
  const known = buildAutonomyContext(input({
    lastAutonomousMessageAt: NOW - 2 * HOUR,
    lastWorldObservationAt: NOW - HOUR,
    lastWorldObservationShareAt: NOW - 5 * MINUTE,
  }));
  assert.match(known, /真实自主发送：2 小时前/);
  assert.match(known, /世界观察：1 小时前/);
  assert.match(known, /观察分享：5 分钟前/);

  const unknown = buildAutonomyContext(input({ lastWorldObservationShareAt: NOW - 5 * MINUTE }));
  assert.match(unknown, /真实自主发送：未知/);
  assert.match(unknown, /不代表从未发过/);
});

test("each known observation or social send ends the previous creative streak", () => {
  const recentActions = [
    { kind: "archive_writing" as const, at: NOW - 50 * MINUTE, title: "旧作品" },
    { kind: "memory_reflection" as const, at: NOW - 30 * MINUTE, title: "中间的反思" },
    { kind: "archive_writing" as const, at: NOW - 5 * MINUTE, title: "新作品" },
  ];
  for (const boundary of ["lastWorldObservationAt", "lastAutonomousMessageAt", "lastWorldObservationShareAt"] as const) {
    const context = buildAutonomyContext(input({ recentActions, [boundary]: NOW - 10 * MINUTE }));
    assert.match(context, /连续创作 1 次/, boundary);
  }
});

test("recent creative subjects are presented newest first without losing action kind", () => {
  const context = buildAutonomyContext(input({ recentActions: [
    { kind: "archive_writing", at: NOW - HOUR, title: "旧作品" },
    { kind: "memory_reflection", at: NOW - 5 * MINUTE, title: "新的反思" },
    { kind: "archive_writing", at: 0, title: "时间不明的作品" },
  ] }));

  assert.ok(context.indexOf("新的反思") < context.indexOf("旧作品"));
  assert.match(context, /记忆反思.*新的反思/);
  assert.match(context, /归档写作.*旧作品/);
  assert.match(context, /未知.*时间不明的作品/);
  assert.match(context, /连续创作 2 次/);
});

test("topic context uses the supplied current configuration and keeps an empty target list empty", () => {
  const context = buildAutonomyContext(input({ topics: [
    { topic: "数学", lastAt: NOW - HOUR, outcome: "读到一篇论文", targetConversationIds: ["math-room"] },
    { topic: "GitHub Trending", lastAt: 0, outcome: "", targetConversationIds: [] },
  ] }));

  assert.match(context, /数学.*1 小时前.*读到一篇论文.*math-room/);
  assert.match(context, /GitHub Trending.*未知.*未配置分享目标/);
  assert.equal(context.split("math-room").length - 1, 1);
  assert.match(buildAutonomyContext(input({ worldObservationEnabled: false })), /世界观察当前关闭/);
  assert.match(buildAutonomyContext(input()), /未配置观察话题/);
});

test("repeated creative work with quiet or unknown sharing invites an optional look outward", () => {
  const recentActions = [1, 2, 3].map((hour) => ({
    kind: "archive_writing" as const,
    at: NOW - hour * HOUR,
    title: `作品${hour}`,
  }));
  for (const lastAutonomousMessageAt of [0, NOW - 8 * HOUR]) {
    const context = buildAutonomyContext(input({
      lastAutonomousMessageAt,
      recentActions,
      topics: [{ topic: "天文", lastAt: 0, outcome: "", targetConversationIds: ["sky-room"] }],
    }));
    assert.match(context, /可以考虑.*观察.*会话/);
    assert.match(context, /没有合适内容时可以不发/);
  }

  const recentSharing = buildAutonomyContext(input({
    lastAutonomousMessageAt: NOW - MINUTE,
    recentActions: recentActions.map((action, i) => ({ ...action, at: NOW - (i + 1) * 10_000 })),
  }));
  assert.match(recentSharing, /连续创作 3 次/);
  assert.doesNotMatch(recentSharing, /可以考虑/);
});

test("long retained histories stay bounded and rendering does not reorder caller state", () => {
  const recentActions = Object.freeze(Array.from({ length: 60 }, (_, i) => Object.freeze({
    kind: "archive_writing" as const,
    at: NOW - (60 - i) * MINUTE,
    title: `作品${i}:` + "长".repeat(10_000),
  })));
  const topics = Object.freeze(Array.from({ length: 40 }, (_, i) => Object.freeze({
    topic: `话题${i}:` + "名".repeat(10_000),
    lastAt: NOW - HOUR,
    outcome: "结果".repeat(10_000),
    targetConversationIds: Object.freeze(Array.from({ length: 30 }, (_, j) => `目标${j}:` + "号".repeat(10_000))),
  })));
  const context = buildAutonomyContext(input({ recentActions, topics }));

  assert.ok(context.length < 6_000);
  assert.ok(context.includes("作品59:"));
  assert.ok(!context.includes("作品0:"));
  assert.ok(!context.includes("话题39:"));
  assert.ok(!context.includes("目标29:"));
  assert.match(context, /另有 \d+ 条/);
  assert.match(context, /另有 \d+ 个话题/);
  assert.equal(recentActions[0].title.slice(0, 4), "作品0:");
});

test("invalid or future timestamps remain unknown and do not manufacture creative activity", () => {
  const context = buildAutonomyContext(input({
    lastAutonomousMessageAt: Number.NaN,
    lastWorldObservationAt: NOW + HOUR,
    lastWorldObservationShareAt: -1,
    recentActions: [{ kind: "archive_writing", at: NOW + HOUR, title: "未来作品" }],
  }));

  assert.match(context, /真实自主发送：未知/);
  assert.match(context, /世界观察：未知/);
  assert.match(context, /观察分享：未知/);
  assert.match(context, /连续创作 0 次/);
  assert.doesNotMatch(context, /NaN|负|分钟前/);
});
