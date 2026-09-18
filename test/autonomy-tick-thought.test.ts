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

// observe_world 不再是这个循环的动作——它成了她手边的子工具，什么时候用是她自己那一轮的
// 判断，这条记录里看不到。换成现在真会出现的那个：冒了个念头。
test("autonomy tick thought reports a thought handed over, not an action taken", () => {
  const result: AutonomyLoopResult = {
    action: { type: "inner_thought", reason: "闲下来了，冒个念头" },
    checks: [{
      name: "inner_voice",
      status: "acted",
      reason: "冒了个念头，接下来看她自己",
      nextEligibleAt: null,
    }],
  };

  const thought = buildAutonomyTickThought(result, NOW);
  assert.equal(thought.outcome, "inner_thought");
  assert.match(thought.summary, /接下来做什么看她自己/);
  // 念头原文进的是她的账本，不在这条运维记录里复述。
  assert.match(thought.summary, /冒个念头/);
});

test("世界观察没被选中的那一行不进 Thoughts，其余明细照常列出", () => {
  const result: AutonomyLoopResult = {
    action: { type: "do_nothing", reason: "三个话题最近都刚看过，这一轮静观即可" },
    checks: [
      { name: "world_observation", status: "deferred", reason: "模型本轮选择优先做别的", nextEligibleAt: null },
      { name: "memory_reflection", status: "waiting", reason: "距离上次完成尚未达到配置间隔", nextEligibleAt: NOW + 42 * 60_000 },
      { name: "archive_writing", status: "disabled", reason: "归档写作已关闭", nextEligibleAt: null },
      // 只去掉世界观察那一行：群聊主动开口的顺延只在有事可做时才出现，不是每分钟的固定噪声。
      { name: "group_proactive", status: "deferred", reason: "模型本轮选择优先做别的", nextEligibleAt: null },
    ],
  };

  const thought = buildAutonomyTickThought(result, NOW);
  assert.doesNotMatch(thought.summary, /世界观察：/);
  assert.match(thought.summary, /未行动原因：三个话题最近都刚看过/);
  assert.match(thought.summary, /记忆反思：等待中/);
  assert.match(thought.summary, /归档写作：已关闭/);
  assert.match(thought.summary, /群聊主动开口：本轮顺延/);
});
