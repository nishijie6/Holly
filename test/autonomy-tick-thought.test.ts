import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAutonomyTickThought } from "../autonomy-tick-thought.js";
import type { AutonomyLoopResult } from "../autonomy-engine.js";

const NOW = Date.UTC(2026, 7, 13, 3, 0, 0);

test("autonomy tick thought explains every idle check and its wait", () => {
  const result: AutonomyLoopResult = {
    action: {
      type: "do_nothing",
      reason: "没有群聊同时通过冷场、兴趣话题、冷却和限流规则",
    },
    checks: [
      {
        name: "world_observation",
        status: "waiting",
        reason: "距离上次完成尚未达到配置间隔",
        nextEligibleAt: NOW + 5 * 60_000,
      },
      {
        name: "memory_reflection",
        status: "disabled",
        reason: "记忆反思已关闭",
        nextEligibleAt: null,
      },
      {
        name: "archive_writing",
        status: "waiting",
        reason: "距离上次完成尚未达到配置间隔",
        nextEligibleAt: NOW + 60 * 60_000,
      },
      {
        name: "group_proactive",
        status: "no_action",
        reason: "没有群聊同时通过冷场、兴趣话题、冷却和限流规则",
        nextEligibleAt: null,
      },
    ],
  };

  const thought = buildAutonomyTickThought(result, NOW);
  assert.equal(thought.outcome, "idle");
  assert.equal(thought.finalAnswer, "");
  assert.match(thought.summary, /本轮结果：未行动/);
  assert.match(thought.summary, /未行动原因/);
  assert.match(thought.summary, /世界观察：等待中/);
  assert.match(thought.summary, /约 5 分钟后可再次执行/);
  assert.match(thought.summary, /记忆反思：已关闭/);
  assert.match(thought.summary, /群聊主动开口：未行动/);
});

test("autonomy tick thought exposes shadow proactive output", () => {
  const result: AutonomyLoopResult = {
    action: {
      type: "send_group_message",
      reason: "group proactive policy produced an action",
      actions: [{
        type: "send_group_message",
        mode: "shadow",
        groupKey: "123",
        groupId: 123,
        threadKey: "ai:1",
        matchedKeyword: "AI",
        text: "这个新模型的推理速度挺有意思",
      }],
    },
    checks: [{
      name: "group_proactive",
      status: "acted",
      reason: "产生 1 个主动开口动作（shadow）",
      nextEligibleAt: null,
    }],
  };

  const thought = buildAutonomyTickThought(result, NOW);
  assert.equal(thought.outcome, "proactive_shadow");
  assert.equal(thought.groupId, "123");
  assert.equal(thought.finalAnswer, "这个新模型的推理速度挺有意思");
  assert.match(thought.summary, /影子模式 1/);
});
