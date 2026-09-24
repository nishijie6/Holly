import { test } from "node:test";
import assert from "node:assert/strict";

import {
  JUDGMENT_FAILURE_BACKOFF_MS,
  JUDGMENT_FAILURE_BACKOFF_THRESHOLD,
  resolveWorldObservationBroadcastGroupIds,
  rollAutonomyDaily,
  runAutonomyLoop,
  worldObservationBroadcastGroupIds,
  type AutonomyConfig,
  type AutonomyDeps,
  type AutonomyLoopState,
} from "../autonomy-engine.js";
import type { ProactiveTickResult } from "../proactive-engine.js";

// 这个循环现在只发起两件事：按规则闸主动开口，或者冒一个念头交给她。观察世界、写记忆、
// 写作品都成了她手边的子工具（self-tools.ts），什么时候用是她自己那一轮的判断，这里看不见。

const MIN = 60 * 1000;
// 北京时间 20 点，在触发门控的静默窗之外。
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

const EMPTY_PROACTIVE: ProactiveTickResult = { actions: [] };

function baseConfig(overrides: Partial<AutonomyConfig> = {}): AutonomyConfig {
  return {
    enabled: true,
    worldObservationEnabled: true,
    worldObservationRetryMs: 10 * MIN,
    worldObservationBroadcastGroupId: null,
    worldObservationFailureGroupId: null,
    worldObservationBroadcastLullMs: 30 * MIN,
    worldTopics: ["AI latest", "astronomy latest"],
    memoryReflectionEnabled: true,
    memoryReflectionIntervalMs: 30 * MIN,
    memoryReflectionRetryMs: 10 * MIN,
    memoryReflectionBroadcastGroupId: null,
    memoryReflectionBroadcastLullMs: 180 * MIN,
    archiveWritingEnabled: false,
    archiveWritingRetryMs: 60 * MIN,
    worldTopicQuerySuffixOverrides: {},
    worldTopicBroadcastGroupOverrides: {},
    worldTopicSourceUrls: {},
    worldTopicBriefs: {},
    worldObservationDedupWindowMs: 168 * 60 * MIN,
    ...overrides,
  };
}

function baseState(overrides: Partial<AutonomyLoopState> = {}): AutonomyLoopState {
  return {
    lastWorldObservationAt: 0,
    lastWorldObservationAttemptAt: 0,
    worldObservationDailyDate: "2026-01-01",
    worldObservationDailyCount: 0,
    nextWorldTopicIndex: 0,
    lastMemoryReflectionAt: 0,
    lastMemoryReflectionAttemptAt: 0,
    memoryReflectionDailyDate: "2026-01-01",
    memoryReflectionDailyCount: 0,
    lastArchiveWritingAt: 0,
    lastArchiveWritingAttemptAt: 0,
    archiveWritingDailyDate: "2026-01-01",
    archiveWritingDailyCount: 0,
    lastWorldObservationShareAt: 0,
    worldObservationShareDailyDate: "2026-01-01",
    worldObservationShareDailyCount: 0,
    recentActions: [],
    lastJudgmentAt: 0,
    judgmentFailureStreak: 0,
    lastJudgmentFailureAt: 0,
    ...overrides,
  };
}

function baseDeps(
  overrides: Partial<AutonomyDeps> & { config?: AutonomyConfig; state?: AutonomyLoopState },
): AutonomyDeps {
  const state = overrides.state ?? baseState();
  const config = overrides.config ?? baseConfig();
  return {
    now: () => NOW,
    config,
    getState: () => state,
    saveState: async () => {},
    emitInnerThought: async () => {},
    runGroupProactiveAction: async () => EMPTY_PROACTIVE,
    // 0 = 本次启动以来群里没动静 = 她闲着，触发门控放行。要测「正忙着」的用例自己覆盖它。
    lastFocusActivityAt: () => 0,
    hasProactiveWork: () => false,
    log: () => {},
    ...overrides,
  };
}

// ---------- 闲下来就冒个念头，剩下的看她自己 ----------

test("闲下来、没别的事，就冒个念头", async () => {
  const state = baseState();
  let emitted = 0;
  const result = await runAutonomyLoop(baseDeps({
    state,
    emitInnerThought: async () => { emitted += 1; },
  }));

  assert.equal(emitted, 1);
  assert.equal(result.action.type, "inner_thought");
  assert.equal(state.lastJudgmentAt, NOW);
});

// 念头本身不经过这里——它进的是她的账本，由 main.ts 那条路径处理。这个循环只管什么时候冒。
test("这个循环不碰念头的内容", async () => {
  const result = await runAutonomyLoop(baseDeps({}));
  assert.equal(result.action.type, "inner_thought");
  assert.ok(!("thought" in result.action), "念头内容不该出现在引擎的返回里");
});

// 主动开口有自己一整套规则闸（冷场时长、兴趣话题、冷却、限流、影子模式），那是单独设计过的
// 安全边界。换了形状之后它仍然优先，不该被绕开。
test("主动开口有活干就先做，这一轮不冒念头", async () => {
  let emitted = 0;
  const result = await runAutonomyLoop(baseDeps({
    hasProactiveWork: () => true,
    runGroupProactiveAction: async () => ({
      actions: [{ groupKey: "100", text: "在的", mode: "live" }],
    } as ProactiveTickResult),
    emitInnerThought: async () => { emitted += 1; },
  }));

  assert.equal(result.action.type, "send_group_message");
  assert.equal(emitted, 0, "这一轮已经去主动开口了，不该再冒念头");
});

test("主动开口最后没发出东西，还是回到冒念头", async () => {
  let emitted = 0;
  const result = await runAutonomyLoop(baseDeps({
    hasProactiveWork: () => true,
    runGroupProactiveAction: async () => EMPTY_PROACTIVE,
    emitInnerThought: async () => { emitted += 1; },
  }));

  assert.equal(emitted, 1);
  assert.equal(result.action.type, "inner_thought");
});

// 闸没过，和闸过了、跑了一轮却没产出动作，是两回事：前者是还没轮到她说话，后者是轮到了、
// 但没什么可说。合成一句「规则闸未通过」，看监控的人就分不出来了。
test("主动开口跑过一轮却没产出，trace 要说实话", async () => {
  const result = await runAutonomyLoop(baseDeps({
    hasProactiveWork: () => true,
    runGroupProactiveAction: async () => EMPTY_PROACTIVE,
  }));

  const check = result.checks.find((item) => item.name === "group_proactive");
  assert.equal(check?.status, "no_action");
  assert.match(check?.reason ?? "", /规则闸过了/);
});

test("规则闸压根没过时，报的才是闸没过", async () => {
  const result = await runAutonomyLoop(baseDeps({ hasProactiveWork: () => false }));

  const check = result.checks.find((item) => item.name === "group_proactive");
  assert.equal(check?.status, "deferred");
  assert.match(check?.reason ?? "", /规则闸未通过/);
});

test("关掉自主循环就什么都不做", async () => {
  let emitted = 0;
  const result = await runAutonomyLoop(baseDeps({
    config: baseConfig({ enabled: false }),
    emitInnerThought: async () => { emitted += 1; },
  }));

  assert.equal(emitted, 0);
  assert.equal(result.action.type, "do_nothing");
});

// 关掉时报的必须是这个循环现在真会做的两件事。报那三个已经退役的名字，面板上就会出现三行
// 「已关闭」的幽灵检查，而真正被关掉的那一项反倒不见了。
test("关掉时报的是现在这两项检查", async () => {
  const result = await runAutonomyLoop(baseDeps({ config: baseConfig({ enabled: false }) }));

  assert.deepEqual(result.checks.map((check) => check.name), ["inner_voice", "group_proactive"]);
  assert.deepEqual([...new Set(result.checks.map((check) => check.status))], ["disabled"]);
});

// ---------- 闲下来才问，别每分钟都问一次 ----------

test("她正在群里说话时，这一轮不冒念头", async () => {
  let emitted = 0;
  const result = await runAutonomyLoop(baseDeps({
    lastFocusActivityAt: () => NOW - 1 * MIN,
    emitInnerThought: async () => { emitted += 1; },
  }));

  assert.equal(emitted, 0, "她忙着的时候不该打断");
  assert.equal(result.action.type, "do_nothing");
  assert.deepEqual([...new Set(result.checks.map((check) => check.status))], ["waiting"]);
});

test("刚冒过就等不应期过去", async () => {
  let emitted = 0;
  await runAutonomyLoop(baseDeps({
    state: baseState({ lastJudgmentAt: NOW - 3 * MIN }),
    emitInnerThought: async () => { emitted += 1; },
  }));

  assert.equal(emitted, 0);
});

test("不应期过了就能再冒", async () => {
  let emitted = 0;
  await runAutonomyLoop(baseDeps({
    state: baseState({ lastJudgmentAt: NOW - 16 * MIN }),
    emitInnerThought: async () => { emitted += 1; },
  }));

  assert.equal(emitted, 1);
});

// 归档写作还在重试间隔里，跟她此刻该不该冒个念头毫无关系。那套候选资格体系退役掉，正是
// 为了不让她因为一件根本没打算做的事被按住不动。
test("她的念头不被那些已退役的间隔挡住", async () => {
  let emitted = 0;
  await runAutonomyLoop(baseDeps({
    state: baseState({
      lastArchiveWritingAttemptAt: NOW - 1 * MIN,
      lastMemoryReflectionAt: NOW - 1 * MIN,
      lastWorldObservationAttemptAt: NOW - 1 * MIN,
    }),
    config: baseConfig({ archiveWritingEnabled: true }),
    emitInnerThought: async () => { emitted += 1; },
  }));

  assert.equal(emitted, 1);
});

// ---------- 连着失败时别每分钟都去撞墙 ----------

test("一次失败只是这一轮做不成，下一轮照常", async () => {
  const state = baseState();
  const result = await runAutonomyLoop(baseDeps({
    state,
    emitInnerThought: async () => { throw new Error("boom"); },
  }));

  assert.equal(state.judgmentFailureStreak, 1);
  assert.equal(state.lastJudgmentFailureAt, NOW);
  assert.equal(result.action.type, "do_nothing");
  assert.match((result.action as { reason: string }).reason, /冒念头失败/);
});

test("连着失败到阈值就停一段时间，期间一次都不试", async () => {
  let emitted = 0;
  const result = await runAutonomyLoop(baseDeps({
    state: baseState({
      judgmentFailureStreak: JUDGMENT_FAILURE_BACKOFF_THRESHOLD,
      lastJudgmentFailureAt: NOW - 60_000,
    }),
    emitInnerThought: async () => { emitted += 1; },
  }));

  assert.equal(emitted, 0, "退避期内不该再试");
  assert.deepEqual([...new Set(result.checks.map((check) => check.status))], ["waiting"]);
});

test("退避到期后自己恢复", async () => {
  let emitted = 0;
  await runAutonomyLoop(baseDeps({
    state: baseState({
      judgmentFailureStreak: JUDGMENT_FAILURE_BACKOFF_THRESHOLD,
      lastJudgmentFailureAt: NOW - JUDGMENT_FAILURE_BACKOFF_MS - 1000,
    }),
    emitInnerThought: async () => { emitted += 1; },
  }));

  assert.equal(emitted, 1);
});

test("成功一次就把连败清零", async () => {
  const state = baseState({
    judgmentFailureStreak: JUDGMENT_FAILURE_BACKOFF_THRESHOLD - 1,
    lastJudgmentFailureAt: NOW - 60_000,
  });
  await runAutonomyLoop(baseDeps({ state }));

  assert.equal(state.judgmentFailureStreak, 0);
});

// 失败另有连败退避管着。要是失败不算数，一个每次都报错的调用就能绕开不应期，退回每分钟一次。
test("失败了也算这一轮动过，一样要等不应期", async () => {
  const state = baseState();
  await runAutonomyLoop(baseDeps({
    state,
    emitInnerThought: async () => { throw new Error("boom"); },
  }));

  assert.equal(state.lastJudgmentAt, NOW);
});

// ---------- 播报目标群的解析（与这次改动无关，原样保留） ----------

test("resolveWorldObservationBroadcastGroupIds 按话题覆盖，空列表表示不播报", () => {
  const config = baseConfig({
    worldObservationBroadcastGroupId: "default",
    worldTopicBroadcastGroupOverrides: { 数学: [], 天文学: ["a", "b"] },
  });
  assert.deepEqual(resolveWorldObservationBroadcastGroupIds(config, "数学"), []);
  assert.deepEqual(resolveWorldObservationBroadcastGroupIds(config, "天文学"), ["a", "b"]);
  assert.deepEqual(resolveWorldObservationBroadcastGroupIds(config, "没配过的"), ["default"]);
});

test("worldObservationBroadcastGroupIds 把所有可能收到播报的群合在一起", () => {
  const config = baseConfig({
    worldObservationBroadcastGroupId: "default",
    worldTopicBroadcastGroupOverrides: { 数学: ["a"], 天文学: ["a", "b"] },
  });
  assert.deepEqual(worldObservationBroadcastGroupIds(config).sort(), ["a", "b", "default"]);
});

test("转发计数跟别的当日计数一起跨天清零", () => {
  // NOW 是 2026-01-01，前一天的计数要清零，当天的原样留着。
  const state = baseState({ worldObservationShareDailyDate: "2025-12-31", worldObservationShareDailyCount: 4 });
  rollAutonomyDaily(state, NOW);
  assert.equal(state.worldObservationShareDailyCount, 0);
  assert.equal(state.worldObservationShareDailyDate, "2026-01-01");
  state.worldObservationShareDailyCount = 2;
  rollAutonomyDaily(state, NOW);
  assert.equal(state.worldObservationShareDailyCount, 2);
});
