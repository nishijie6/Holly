import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runAutonomyLoop,
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
    worldObservationIntervalMs: 60 * MIN,
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
    // World: interval cleared (60min ago). Memory: not yet (10min ago, 30min interval).
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
  // world_observation is NOT due (just observed 5min ago against a 60min
  // interval); a malformed/hallucinated pick of it must never run the branch.
  const state = baseState({ lastWorldObservationAt: NOW - 5 * MIN });
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
