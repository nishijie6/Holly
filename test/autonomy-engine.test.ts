import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RECENT_AUTONOMY_ACTION_LIMIT,
  resolveWorldObservationBroadcastGroupIds,
  runAutonomyLoop,
  worldObservationBroadcastGroupIds,
  type AutonomyConfig,
  type AutonomyDeps,
  type AutonomyJudgmentDecision,
  type AutonomyJudgmentRequest,
  type AutonomyLoopState,
} from "../autonomy-engine.js";
import type { ProactiveTickResult, ProactiveWorldObservation } from "../proactive-engine.js";

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

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
    archiveWritingIntervalMs: 240 * MIN,
    archiveWritingRetryMs: 60 * MIN,
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
    recentActions: [],
    ...overrides,
  };
}

const OBSERVATION: ProactiveWorldObservation = {
  query: "AI latest",
  summary: "Browser observation summary",
  urls: ["https://example.com/ai"],
};

const EMPTY_PROACTIVE: ProactiveTickResult = { actions: [] };

// Every test wires only the deps it cares about; everything else is a no-op
// stub that fails the test loudly (via an unexpected call assertion) if the
// loop reaches it when it shouldn't -- the whole point of moving to judgment
// is that only the picked branch's deps run.
function baseDeps(overrides: Partial<AutonomyDeps> & { config?: AutonomyConfig; state?: AutonomyLoopState }): AutonomyDeps {
  const state = overrides.state ?? baseState();
  const config = overrides.config ?? baseConfig();
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    now: () => NOW,
    config,
    getState: () => state,
    saveState: async () => {},
    observeWorld: unexpected("observeWorld"),
    reflectMemory: unexpected("reflectMemory"),
    writeMemory: unexpected("writeMemory"),
    composeArchive: unexpected("composeArchive"),
    writeArchive: unexpected("writeArchive"),
    runGroupProactiveAction: unexpected("runGroupProactiveAction"),
    requestJudgment: async () => ({ action: "do_nothing", reason: "test default" }),
    // 默认「主动发言没事做」：这样一个三候选都没到期的 deps 会走短路，想测判断调用的
    // 用例本来就都有候选到期，不受影响。
    hasProactiveWork: () => false,
    worldTopicStatuses: () => [],
    pendingReplyGroupCount: () => 0,
    log: () => {},
    recordWorldObservation: () => {},
    ...overrides,
  };
}

function judgment(action: AutonomyJudgmentDecision["action"], reason = "test pick"): AutonomyDeps["requestJudgment"] {
  return async () => ({ action, reason } as AutonomyJudgmentDecision);
}

test("cfg.enabled=false short-circuits without calling requestJudgment", async () => {
  let judgmentCalls = 0;
  const result = await runAutonomyLoop(baseDeps({
    config: baseConfig({ enabled: false }),
    requestJudgment: async () => {
      judgmentCalls += 1;
      return { action: "do_nothing", reason: "should not be reached" };
    },
  }));

  assert.equal(result.action.type, "do_nothing");
  assert.equal(judgmentCalls, 0);
  assert.ok(result.checks.every((check) => check.status === "disabled"));
});

test("the judgment request reports eligibility matching the due checks, and group_proactive as always offerable", async () => {
  const state = baseState({
    // 世界观察没有间隔，一直可选。记忆反思还没到（10 分钟前做过，间隔 30 分钟）。
    lastWorldObservationAt: NOW - 65 * MIN,
    lastMemoryReflectionAt: NOW - 10 * MIN,
  });
  let seenRequest: AutonomyJudgmentRequest | null = null;

  await runAutonomyLoop(baseDeps({
    state,
    config: baseConfig({ archiveWritingEnabled: false }),
    requestJudgment: async (request) => {
      seenRequest = request;
      return { action: "do_nothing", reason: "observing only" };
    },
  }));

  assert.ok(seenRequest);
  assert.equal(seenRequest!.worldObservation.eligible, true);
  assert.equal(seenRequest!.memoryReflection.eligible, false);
  assert.equal(seenRequest!.archiveWriting.eligible, false);
  assert.match(seenRequest!.groupProactiveNote, /始终可选/);
});

test("the judgment request carries the pending-reply count for awareness only", async () => {
  let seenCount: number | null = null;
  await runAutonomyLoop(baseDeps({
    pendingReplyGroupCount: () => 3,
    requestJudgment: async (request) => {
      seenCount = request.pendingReplyGroupCount;
      return { action: "do_nothing", reason: "irrelevant to reply" };
    },
  }));
  assert.equal(seenCount, 3);
});

test("picking world_observation runs only observeWorld and reports the outcome", async () => {
  const state = baseState({ lastWorldObservationAt: NOW - 65 * MIN });
  let observeCalls = 0;
  const records: Record<string, unknown>[] = [];

  const result = await runAutonomyLoop(baseDeps({
    state,
    requestJudgment: judgment("world_observation"),
    observeWorld: async (request) => {
      observeCalls += 1;
      assert.equal(request.topic, "AI latest");
      return OBSERVATION;
    },
    recordWorldObservation: (record) => records.push(record),
  }));

  assert.equal(result.action.type, "observe_world");
  assert.equal(observeCalls, 1);
  assert.equal(state.worldObservationDailyCount, 1);
  assert.equal(state.lastWorldObservationAt, NOW);
  assert.equal(state.nextWorldTopicIndex, 1);
  assert.equal(records.length, 1);

  const worldCheck = result.checks.find((check) => check.name === "world_observation");
  assert.equal(worldCheck?.status, "acted");
  // Every other candidate was left untouched -- eligible or not, none of them
  // ran (archive_writing is disabled by baseConfig(), memory_reflection is
  // eligible-but-unpicked here; neither should read as "acted").
  const others = result.checks.filter((check) => check.name !== "world_observation");
  assert.ok(others.every((check) => check.status !== "acted"));
});

test("an empty world observation reports no_action but still records the attempt", async () => {
  const state = baseState({ lastWorldObservationAt: NOW - 65 * MIN });
  const result = await runAutonomyLoop(baseDeps({
    state,
    requestJudgment: judgment("world_observation"),
    observeWorld: async () => null,
  }));

  assert.equal(result.action.type, "observe_world");
  assert.equal(result.action.type === "observe_world" && result.action.observed, false);
  // Only set on a successful observation -- unchanged from the eligible-but-
  // untouched starting value, not reset to 0.
  assert.equal(state.lastWorldObservationAt, NOW - 65 * MIN);
  assert.equal(state.lastWorldObservationAttemptAt, NOW);
});

test("a failed world observation logs the error and reports no_action", async () => {
  const state = baseState({ lastWorldObservationAt: NOW - 65 * MIN });
  const errors: string[] = [];
  const result = await runAutonomyLoop(baseDeps({
    state,
    requestJudgment: judgment("world_observation"),
    observeWorld: async () => {
      throw new Error("network unavailable");
    },
    log: (kind, title, body) => {
      if (kind === "error") errors.push(`${title}\n${body}`);
    },
  }));

  assert.equal(result.action.type, "observe_world");
  assert.equal(result.action.type === "observe_world" && result.action.observed, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /network unavailable/);
});

test("picking memory_reflection runs only reflectMemory+writeMemory", async () => {
  const state = baseState({ lastMemoryReflectionAt: NOW - 65 * MIN });
  let reflectionCalls = 0;
  let writeCalls = 0;

  const result = await runAutonomyLoop(baseDeps({
    state,
    requestJudgment: judgment("memory_reflection"),
    reflectMemory: async (request) => {
      reflectionCalls += 1;
      assert.equal(request.reason, "scheduled memory reflection");
      return { topic: "AI interest", reason: "scheduled memory reflection", content: "tracking small updates" };
    },
    writeMemory: async (request) => {
      writeCalls += 1;
      assert.equal(request.topic, "AI interest");
    },
  }));

  assert.equal(result.action.type, "write_memory");
  assert.equal(reflectionCalls, 1);
  assert.equal(writeCalls, 1);
  assert.equal(state.memoryReflectionDailyCount, 1);
  assert.equal(state.lastMemoryReflectionAt, NOW);
});

test("memory_reflection with nothing to write falls back to do_nothing, not another candidate", async () => {
  const state = baseState({ lastMemoryReflectionAt: NOW - 65 * MIN });
  const result = await runAutonomyLoop(baseDeps({
    state,
    requestJudgment: judgment("memory_reflection"),
    reflectMemory: async () => null,
  }));

  assert.equal(result.action.type, "do_nothing");
  // lastMemoryReflectionAt is only set on a successful write -- unchanged
  // from the eligible-but-untouched starting value, not reset to 0.
  assert.equal(state.lastMemoryReflectionAt, NOW - 65 * MIN);
  assert.equal(state.lastMemoryReflectionAttemptAt, NOW);
  const check = result.checks.find((c) => c.name === "memory_reflection");
  assert.equal(check?.status, "no_action");
});

test("a writeMemory failure after a successful reflection still resolves to do_nothing, not left unassigned", async () => {
  const state = baseState({ lastMemoryReflectionAt: NOW - 65 * MIN });
  const result = await runAutonomyLoop(baseDeps({
    state,
    requestJudgment: judgment("memory_reflection"),
    reflectMemory: async () => ({ topic: "x", reason: "y", content: "z" }),
    writeMemory: async () => {
      throw new Error("disk full");
    },
  }));

  assert.equal(result.action.type, "do_nothing");
  assert.match((result.action as { reason: string }).reason, /disk full/);
  // lastMemoryReflectionAt is only set on a successful write.
  assert.equal(state.lastMemoryReflectionAt, NOW - 65 * MIN);
});

test("picking archive_writing runs only composeArchive+writeArchive", async () => {
  const state = baseState({ lastArchiveWritingAt: NOW - 245 * MIN });
  let composeCalls = 0;
  let writeCalls = 0;

  const result = await runAutonomyLoop(baseDeps({
    state,
    config: baseConfig({ archiveWritingEnabled: true }),
    requestJudgment: judgment("archive_writing"),
    composeArchive: async (request) => {
      composeCalls += 1;
      assert.equal(request.reason, "scheduled archive writing");
      return { kind: "poem", title: "星尘", content: "第一行\n第二行", reason: "sparked it" };
    },
    writeArchive: async (request) => {
      writeCalls += 1;
      assert.equal(request.title, "星尘");
    },
  }));

  assert.equal(result.action.type, "write_archive");
  assert.equal(composeCalls, 1);
  assert.equal(writeCalls, 1);
  assert.equal(state.archiveWritingDailyCount, 1);
  assert.equal(state.lastArchiveWritingAt, NOW);
});

// ---------- 最近写过什么，判断层要看得见 ----------

test("写成了就把题目记下来，交给下一轮判断去避开", async () => {
  const state = baseState({ lastArchiveWritingAt: NOW - 245 * MIN });
  await runAutonomyLoop(baseDeps({
    state,
    config: baseConfig({ archiveWritingEnabled: true }),
    requestJudgment: judgment("archive_writing"),
    composeArchive: async () => ({ kind: "poem", title: "星尘", content: "第一行", reason: "sparked it" }),
    writeArchive: async () => {},
  }));

  assert.deepEqual(state.recentActions, [{ kind: "archive_writing", at: NOW, title: "星尘" }]);
});

test("记忆反思写进去之后，题目同样留在最近写过的名单里", async () => {
  const state = baseState({ lastMemoryReflectionAt: NOW - 245 * MIN });
  await runAutonomyLoop(baseDeps({
    state,
    config: baseConfig({ memoryReflectionEnabled: true }),
    requestJudgment: judgment("memory_reflection"),
    reflectMemory: async () => ({ topic: "关于噪音", reason: "r", content: "c" }),
    writeMemory: async () => {},
  }));

  assert.deepEqual(state.recentActions, [{ kind: "memory_reflection", at: NOW, title: "关于噪音" }]);
});

// 写失败那次不该留下痕迹：她下一轮应该重新考虑这个题目，而不是以为自己已经写过了。
test("写入失败的那次不算写过", async () => {
  const state = baseState({ lastArchiveWritingAt: NOW - 245 * MIN });
  await runAutonomyLoop(baseDeps({
    state,
    config: baseConfig({ archiveWritingEnabled: true }),
    requestJudgment: judgment("archive_writing"),
    composeArchive: async () => ({ kind: "poem", title: "星尘", content: "第一行", reason: "sparked it" }),
    writeArchive: async () => { throw new Error("disk full"); },
  }));

  assert.deepEqual(state.recentActions, []);
});

// 名单是给判断提示词用的，不能无限长——每分钟一次的调用，多一行就多付一行的钱。
test("名单封顶，最早的那条被挤掉", async () => {
  const older = Array.from({ length: RECENT_AUTONOMY_ACTION_LIMIT }, (_, index) => ({
    kind: "archive_writing" as const,
    at: NOW - (index + 1) * MIN,
    title: `旧作 ${index}`,
  }));
  const state = baseState({ lastArchiveWritingAt: NOW - 245 * MIN, recentActions: [...older] });
  await runAutonomyLoop(baseDeps({
    state,
    config: baseConfig({ archiveWritingEnabled: true }),
    requestJudgment: judgment("archive_writing"),
    composeArchive: async () => ({ kind: "poem", title: "新作", content: "第一行", reason: "sparked it" }),
    writeArchive: async () => {},
  }));

  assert.equal(state.recentActions.length, RECENT_AUTONOMY_ACTION_LIMIT);
  assert.equal(state.recentActions.at(-1)?.title, "新作");
  assert.equal(state.recentActions[0].title, "旧作 1");
});

test("判断请求带上最近写过的题目", async () => {
  const state = baseState({
    lastArchiveWritingAt: NOW - 245 * MIN,
    recentActions: [{ kind: "archive_writing", at: NOW - 30 * MIN, title: "星尘" }],
  });
  let seen: AutonomyJudgmentRequest | null = null;
  await runAutonomyLoop(baseDeps({
    state,
    config: baseConfig({ archiveWritingEnabled: true }),
    requestJudgment: async (request) => {
      seen = request;
      return { action: "do_nothing", reason: "不想写" };
    },
  }));

  assert.deepEqual(seen!.recentActions, [{ kind: "archive_writing", at: NOW - 30 * MIN, title: "星尘" }]);
});

test("archive_writing with nothing composed falls back to do_nothing", async () => {
  const state = baseState({ lastArchiveWritingAt: NOW - 245 * MIN });
  const result = await runAutonomyLoop(baseDeps({
    state,
    config: baseConfig({ archiveWritingEnabled: true }),
    requestJudgment: judgment("archive_writing"),
    composeArchive: async () => null,
  }));

  assert.equal(result.action.type, "do_nothing");
  assert.equal(state.lastArchiveWritingAt, NOW - 245 * MIN);
});

test("picking group_proactive with a real send reports send_group_message", async () => {
  const groupResult: ProactiveTickResult = {
    actions: [{
      type: "send_group_message",
      mode: "shadow",
      groupKey: "111",
      groupId: 111,
      threadKey: "ai:1",
      matchedKeyword: "AI",
      text: "one line",
    }],
  };
  let groupCalls = 0;

  const result = await runAutonomyLoop(baseDeps({
    requestJudgment: judgment("group_proactive"),
    runGroupProactiveAction: async () => {
      groupCalls += 1;
      return groupResult;
    },
  }));

  assert.equal(result.action.type, "send_group_message");
  assert.equal(groupCalls, 1);
});

test("picking group_proactive with nothing to send falls back to do_nothing", async () => {
  const result = await runAutonomyLoop(baseDeps({
    requestJudgment: judgment("group_proactive"),
    runGroupProactiveAction: async () => EMPTY_PROACTIVE,
  }));

  assert.equal(result.action.type, "do_nothing");
  const check = result.checks.find((c) => c.name === "group_proactive");
  assert.equal(check?.status, "no_action");
});

test("picking do_nothing runs no branch dep at all and keeps the model's reason", async () => {
  const result = await runAutonomyLoop(baseDeps({
    requestJudgment: judgment("do_nothing", "nothing worth doing right now"),
  }));

  assert.equal(result.action.type, "do_nothing");
  assert.equal((result.action as { reason: string }).reason, "nothing worth doing right now");
  assert.ok(result.checks.every((check) => check.status === "deferred" || check.status === "waiting" || check.status === "disabled"));
});

test("a judgment pick of an ineligible candidate is defensively ignored, not executed", async () => {
  // 世界观察这一轮不可选：5 分钟前那次抓取失败，还在 10 分钟的重试间隔里。模型乱选、幻觉出来的
  // 选择绝不能真的跑起来。
  const state = baseState({ lastWorldObservationAt: NOW - 90 * MIN, lastWorldObservationAttemptAt: NOW - 5 * MIN });
  let observeCalls = 0;

  const result = await runAutonomyLoop(baseDeps({
    state,
    requestJudgment: judgment("world_observation", "picked anyway"),
    observeWorld: async () => {
      observeCalls += 1;
      return OBSERVATION;
    },
  }));

  assert.equal(observeCalls, 0);
  assert.equal(result.action.type, "do_nothing");
  assert.match((result.action as { reason: string }).reason, /已忽略/);
});

test("requestJudgment throwing degrades the tick to do_nothing instead of propagating", async () => {
  const errors: string[] = [];
  const result = await runAutonomyLoop(baseDeps({
    requestJudgment: async () => {
      throw new Error("LLM unreachable");
    },
    log: (kind, title, body) => {
      if (kind === "error") errors.push(`${title}\n${body}`);
    },
  }));

  assert.equal(result.action.type, "do_nothing");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /LLM unreachable/);
});

test("an eligible-but-unpicked candidate is traced as deferred, not disabled/waiting", async () => {
  const state = baseState({
    lastWorldObservationAt: NOW - 65 * MIN,
    lastMemoryReflectionAt: NOW - 65 * MIN,
  });
  const result = await runAutonomyLoop(baseDeps({
    state,
    requestJudgment: judgment("memory_reflection"),
    reflectMemory: async () => null,
  }));

  const worldCheck = result.checks.find((c) => c.name === "world_observation");
  assert.equal(worldCheck?.status, "deferred");
  assert.match(worldCheck?.reason ?? "", /选择优先做别的/);
});

// 什么都做不了的那一轮跳过判断调用。
//
// 这是 autonomy 最贵的一条线：每分钟一次、一天九百多次，而且每次七百来 token 都够不着
// 最小可缓存长度，一个 token 的缓存都吃不上。绝大多数轮次三个定时候选都没到期、主动发言
// 也在冷却里，那一轮无论模型答什么都只能是 do_nothing。下面钉的是「省得对」：该省的省掉，
// 不该省的一次都不能省——漏掉一次主动发言的机会，代价是 Holly 该说话时没说。

const allIdleState = () => baseState({
  // 记忆反思和归档写作都刚做过，离下次到期还早。世界观察没有间隔，不可选只有一种情况：失败后在等
  // 重试——一分钟前那次没抓到东西。
  lastWorldObservationAt: NOW - 90 * MIN,
  lastWorldObservationAttemptAt: NOW - 1 * MIN,
  lastMemoryReflectionAt: NOW - 1 * MIN,
  lastArchiveWritingAt: NOW - 1 * MIN,
});

test("三候选未到期且主动发言无事可做 → 不调判断模型", async () => {
  let judgmentCalls = 0;
  const result = await runAutonomyLoop(baseDeps({
    state: allIdleState(),
    hasProactiveWork: () => false,
    requestJudgment: async () => {
      judgmentCalls += 1;
      return { action: "do_nothing", reason: "should not be reached" };
    },
  }));

  assert.equal(judgmentCalls, 0);
  assert.equal(result.action.type, "do_nothing");
  assert.match(result.action.reason, /跳过判断调用/u);
});

test("主动发言有事可做时照常问模型，哪怕三个定时候选都没到期", async () => {
  let judgmentCalls = 0;
  await runAutonomyLoop(baseDeps({
    state: allIdleState(),
    // 冷场到点了，或者有观察窗等着结算——这一轮是有事可做的，省不得。
    hasProactiveWork: () => true,
    requestJudgment: async () => {
      judgmentCalls += 1;
      return { action: "do_nothing", reason: "模型说这轮算了" };
    },
  }));

  assert.equal(judgmentCalls, 1);
});

test("任何一个定时候选到期都照常问模型，不看主动发言的脸色", async () => {
  for (const [label, state] of [
    ["world", baseState({ lastWorldObservationAt: NOW - 65 * MIN, lastMemoryReflectionAt: NOW - 1 * MIN, lastArchiveWritingAt: NOW - 1 * MIN })],
    ["memory", baseState({ lastWorldObservationAt: NOW - 90 * MIN, lastWorldObservationAttemptAt: NOW - 1 * MIN, lastMemoryReflectionAt: NOW - 35 * MIN, lastArchiveWritingAt: NOW - 1 * MIN })],
  ] as const) {
    let judgmentCalls = 0;
    await runAutonomyLoop(baseDeps({
      state,
      hasProactiveWork: () => false,
      requestJudgment: async () => {
        judgmentCalls += 1;
        return { action: "do_nothing", reason: "模型说这轮算了" };
      },
    }));
    assert.equal(judgmentCalls, 1, `${label} 到期时必须问模型`);
  }
});

test("跳过的那一轮，trace 说的是真实原因，不是「模型选择优先做别的」", async () => {
  const result = await runAutonomyLoop(baseDeps({
    state: allIdleState(),
    hasProactiveWork: () => false,
  }));

  assert.equal(result.checks.length, 4);
  for (const check of result.checks) {
    // 模型这一轮压根没被问过，任何暗示它做了选择的措辞都是在撒谎。
    assert.equal(check.reason.includes("模型本轮选择优先做别的"), false);
  }
  const proactive = result.checks.find((check) => check.name === "group_proactive");
  assert.match(proactive?.reason ?? "", /规则闸未通过/u);
  // 三个定时候选各自带着自己的「还差多久到期」，这是排查时唯一有用的东西。
  const world = result.checks.find((check) => check.name === "world_observation");
  // waiting 而不是 deferred：这一轮没有任何「选择」发生，它就是在等到期而已。
  assert.equal(world?.status, "waiting");
  assert.notEqual(world?.nextEligibleAt, null);
});

test("短路不写状态：跳过的那一轮不该看起来像做过什么", async () => {
  const state = allIdleState();
  const before = JSON.stringify(state);
  await runAutonomyLoop(baseDeps({ state, hasProactiveWork: () => false }));
  assert.equal(JSON.stringify(state), before);
});

// ---------- 世界观察播报的目标群 ----------

test("一个话题可以配多个群，没配过的话题落回默认群", () => {
  const config = {
    worldObservationBroadcastGroupId: "20000001",
    worldTopicBroadcastGroupOverrides: {
      数学趣题: ["20000002"],
      天文学: ["20000001", "20000002"],
    },
  };

  assert.deepEqual(resolveWorldObservationBroadcastGroupIds(config, "数学趣题"), ["20000002"]);
  // 同一条观察发进两个群，这正是 2026-09-18 加多群的理由。
  assert.deepEqual(resolveWorldObservationBroadcastGroupIds(config, "天文学"), ["20000001", "20000002"]);
  assert.deepEqual(resolveWorldObservationBroadcastGroupIds(config, "人工智能"), ["20000001"]);
  assert.deepEqual(
    resolveWorldObservationBroadcastGroupIds(
      { worldObservationBroadcastGroupId: null, worldTopicBroadcastGroupOverrides: {} },
      "天文学",
    ),
    [],
  );
});

// 监控页上的开关直接改这份名单，所以「空列表」和「没配过」必须是两回事：把一个话题的群全关掉，
// 它就该彻底不播报；要是这时候落回默认群，关掉最后一个开关反而会让它跑去别的群发。
test("一个群都没选的话题彻底不播报，不落回默认群", () => {
  assert.deepEqual(
    resolveWorldObservationBroadcastGroupIds(
      { worldObservationBroadcastGroupId: "20000001", worldTopicBroadcastGroupOverrides: { 天文学: [] } },
      "天文学",
    ),
    [],
  );
});

// 去重把这些群的历史合在一起看；漏掉一个，那个群发过的内容就会在别的群再发一遍。
test("worldObservationBroadcastGroupIds lists every group a broadcast can land in, once each", () => {
  assert.deepEqual(
    worldObservationBroadcastGroupIds({
      worldObservationBroadcastGroupId: "20000001",
      worldTopicBroadcastGroupOverrides: { 人工智能: ["20000001", "20000002"], 天文学: ["20000001"], 数学趣题: ["20000002"] },
    }),
    ["20000001", "20000002"],
  );
  // 页面上取消勾选的群会从名单里消失，但它以前发过的内容仍然是同一条内容流的一部分——这里只看
  // 当前配置，所以重新勾回来的那一刻，去重靠的是那个群自己的历史。
  assert.deepEqual(
    worldObservationBroadcastGroupIds({
      worldObservationBroadcastGroupId: null,
      worldTopicBroadcastGroupOverrides: { 数学趣题: ["20000002"] },
    }),
    ["20000002"],
  );
  assert.deepEqual(
    worldObservationBroadcastGroupIds({
      worldObservationBroadcastGroupId: null,
      worldTopicBroadcastGroupOverrides: {},
    }),
    [],
  );
});

test("世界观察看哪个话题由判断挑，判断给的理由一路带到观察请求里", async () => {
  const state = baseState({ lastWorldObservationAt: NOW - 65 * MIN });
  const requests: Array<{ topic: string; reason: string }> = [];

  const result = await runAutonomyLoop(baseDeps({
    state,
    requestJudgment: async () => ({ action: "world_observation", topic: "astronomy latest", reason: "天文好久没看了" }),
    observeWorld: async (request) => {
      requests.push(request);
      return OBSERVATION;
    },
  }));

  assert.deepEqual(requests, [{ topic: "astronomy latest", reason: "天文好久没看了" }]);
  assert.equal(result.action.type === "observe_world" && result.action.topic, "astronomy latest");
  assert.equal(result.action.type === "observe_world" && result.action.reason, "天文好久没看了");
  // 轮转指针只在退回轮转时才动：模型自己挑的那一轮不该把兜底顺序推乱。
  assert.equal(state.nextWorldTopicIndex, 0);
});

test("判断挑了配置里没有的话题就退回轮转——没配过的话题既没有固定来源也没有播报群", async () => {
  const state = baseState({ lastWorldObservationAt: NOW - 65 * MIN });
  const topics: string[] = [];

  await runAutonomyLoop(baseDeps({
    state,
    requestJudgment: async () => ({ action: "world_observation", topic: "biology", reason: "随便看看" }),
    observeWorld: async (request) => {
      topics.push(request.topic);
      return OBSERVATION;
    },
  }));

  assert.deepEqual(topics, ["AI latest"]);
  assert.equal(state.nextWorldTopicIndex, 1);
});

test("世界观察可选时判断请求带上各话题近况；不可选时连取都不取", async () => {
  const statuses = [
    { topic: "AI latest", lastAt: NOW - 70 * MIN, outcome: "发到了群里" },
    { topic: "astronomy latest", lastAt: 0, outcome: "" },
  ];
  let statusCalls = 0;
  let seen: AutonomyJudgmentRequest | null = null;
  const deps = (state: AutonomyLoopState) => baseDeps({
    state,
    worldTopicStatuses: () => {
      statusCalls += 1;
      return statuses;
    },
    requestJudgment: async (request) => {
      seen = request;
      return { action: "do_nothing", reason: "先不动" };
    },
  });

  await runAutonomyLoop(deps(baseState({ lastWorldObservationAt: NOW - 65 * MIN })));
  assert.deepEqual(seen!.worldTopics, statuses);
  assert.equal(statusCalls, 1);

  // 世界观察刚抓取失败、在等重试；记忆反思从没做过、已经到期，所以判断照样会被问到。
  await runAutonomyLoop(deps(baseState({ lastWorldObservationAt: NOW - 90 * MIN, lastWorldObservationAttemptAt: NOW - 1 * MIN })));
  assert.deepEqual(seen!.worldTopics, []);
  assert.equal(statusCalls, 1);
});

// ---------- 世界观察没有固定间隔 ----------

test("世界观察没有固定间隔：一分钟前刚观察成功，这一轮照样可选", async () => {
  let seen: AutonomyJudgmentRequest | null = null;
  await runAutonomyLoop(baseDeps({
    // 成功的那次，尝试时间和成功时间是同一刻。
    state: baseState({ lastWorldObservationAt: NOW - 1 * MIN, lastWorldObservationAttemptAt: NOW - 1 * MIN }),
    requestJudgment: async (request) => {
      seen = request;
      return { action: "do_nothing", reason: "刚看过" };
    },
  }));

  assert.equal(seen!.worldObservation.eligible, true);
});

test("抓取失败后要等满重试间隔才又可选，等待时 trace 报的是重试", async () => {
  const failedAt = NOW - 5 * MIN;
  const waiting = await runAutonomyLoop(baseDeps({
    // 关掉记忆反思，让这一轮什么都不可选、走短路，trace 里留下的就是世界观察自己的原因。
    config: baseConfig({ memoryReflectionEnabled: false }),
    state: baseState({ lastWorldObservationAt: NOW - 90 * MIN, lastWorldObservationAttemptAt: failedAt }),
  }));
  const world = waiting.checks.find((check) => check.name === "world_observation");
  assert.equal(world?.status, "waiting");
  assert.match(world?.reason ?? "", /重试/);
  assert.equal(world?.nextEligibleAt, failedAt + 10 * MIN);

  let seen: AutonomyJudgmentRequest | null = null;
  await runAutonomyLoop(baseDeps({
    config: baseConfig({ memoryReflectionEnabled: false }),
    state: baseState({ lastWorldObservationAt: NOW - 90 * MIN, lastWorldObservationAttemptAt: NOW - 11 * MIN }),
    requestJudgment: async (request) => {
      seen = request;
      return { action: "do_nothing", reason: "先不去" };
    },
  }));
  assert.equal(seen!.worldObservation.eligible, true);
});
