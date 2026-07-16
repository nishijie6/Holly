import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runAutonomyLoop,
  type AutonomyConfig,
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

test("autonomy loop observes the world without writing memory immediately", async () => {
  const state = baseState();
  let observeCalls = 0;
  let memoryCalls = 0;
  let reflectionCalls = 0;
  let groupCalls = 0;
  const records: Record<string, unknown>[] = [];

  const result = await runAutonomyLoop({
    now: () => NOW,
    config: baseConfig(),
    getState: () => state,
    saveState: async () => {},
    observeWorld: async (request) => {
      observeCalls += 1;
      assert.equal(request.topic, "AI latest");
      return OBSERVATION;
    },
    reflectMemory: async () => {
      reflectionCalls += 1;
      return null;
    },
    writeMemory: async (request) => {
      memoryCalls += 1;
      assert.equal(request.topic, "AI latest");
      assert.match(request.content, /World observation about AI latest/);
    },
    composeArchive: async () => null,
    writeArchive: async () => {},
    runGroupProactiveAction: async () => {
      groupCalls += 1;
      return EMPTY_PROACTIVE;
    },
    log: () => {},
    recordWorldObservation: (record) => records.push(record),
  });

  assert.equal(result.action.type, "observe_world");
  assert.equal(observeCalls, 1);
  assert.equal(reflectionCalls, 0);
  assert.equal(memoryCalls, 0);
  assert.equal(groupCalls, 0);
  assert.equal(state.worldObservationDailyCount, 1);
  assert.equal(state.lastWorldObservationAt, NOW);
  assert.equal(state.nextWorldTopicIndex, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].ok, true);
});

test("autonomy loop does not record an empty world observation", async () => {
  const state = baseState();
  const records: Record<string, unknown>[] = [];

  const result = await runAutonomyLoop({
    now: () => NOW,
    config: baseConfig(),
    getState: () => state,
    saveState: async () => {},
    observeWorld: async () => null,
    reflectMemory: async () => null,
    writeMemory: async () => {},
    composeArchive: async () => null,
    writeArchive: async () => {},
    runGroupProactiveAction: async () => EMPTY_PROACTIVE,
    log: () => {},
    recordWorldObservation: (record) => records.push(record),
  });

  assert.equal(result.action.type, "observe_world");
  assert.equal(result.action.observed, false);
  assert.equal(state.lastWorldObservationAt, 0);
  assert.equal(state.lastWorldObservationAttemptAt, NOW);
  assert.equal(records.length, 0);
});

test("autonomy loop does not record a failed world observation", async () => {
  const state = baseState();
  const records: Record<string, unknown>[] = [];
  const errors: string[] = [];

  const result = await runAutonomyLoop({
    now: () => NOW,
    config: baseConfig(),
    getState: () => state,
    saveState: async () => {},
    observeWorld: async () => {
      throw new Error("network unavailable");
    },
    reflectMemory: async () => null,
    writeMemory: async () => {},
    composeArchive: async () => null,
    writeArchive: async () => {},
    runGroupProactiveAction: async () => EMPTY_PROACTIVE,
    log: (kind, title, body) => {
      if (kind === "error") errors.push(`${title}\n${body}`);
    },
    recordWorldObservation: (record) => records.push(record),
  });

  assert.equal(result.action.type, "observe_world");
  assert.equal(result.action.observed, false);
  assert.equal(state.lastWorldObservationAt, 0);
  assert.equal(state.lastWorldObservationAttemptAt, NOW);
  assert.equal(records.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /network unavailable/);
});

test("autonomy loop writes memory from the independent reflection loop", async () => {
  const state = baseState({ lastWorldObservationAt: NOW - 5 * MIN });
  let observeCalls = 0;
  let reflectionCalls = 0;
  let memoryCalls = 0;
  let groupCalls = 0;

  const result = await runAutonomyLoop({
    now: () => NOW,
    config: baseConfig(),
    getState: () => state,
    saveState: async () => {},
    observeWorld: async () => {
      observeCalls += 1;
      return OBSERVATION;
    },
    reflectMemory: async (request) => {
      reflectionCalls += 1;
      assert.equal(request.reason, "scheduled memory reflection");
      return {
        topic: "AI interest",
        reason: "scheduled memory reflection",
        content: "Holly wants to keep tracking small AI research updates.",
      };
    },
    writeMemory: async (request) => {
      memoryCalls += 1;
      assert.equal(request.topic, "AI interest");
      assert.match(request.content, /tracking/);
    },
    composeArchive: async () => null,
    writeArchive: async () => {},
    runGroupProactiveAction: async () => {
      groupCalls += 1;
      return EMPTY_PROACTIVE;
    },
    log: () => {},
    recordWorldObservation: () => {},
  });

  assert.equal(result.action.type, "write_memory");
  assert.equal(observeCalls, 0);
  assert.equal(reflectionCalls, 1);
  assert.equal(memoryCalls, 1);
  assert.equal(groupCalls, 0);
  assert.equal(state.memoryReflectionDailyCount, 1);
  assert.equal(state.lastMemoryReflectionAt, NOW);
});

test("autonomy loop writes an archive work when the creative loop is due", async () => {
  const state = baseState({
    lastWorldObservationAt: NOW - 5 * MIN,
    lastMemoryReflectionAt: NOW - 5 * MIN,
  });
  let composeCalls = 0;
  let writeCalls = 0;
  let groupCalls = 0;

  const result = await runAutonomyLoop({
    now: () => NOW,
    config: baseConfig({ archiveWritingEnabled: true }),
    getState: () => state,
    saveState: async () => {},
    observeWorld: async () => OBSERVATION,
    reflectMemory: async () => null,
    writeMemory: async () => {},
    composeArchive: async (request) => {
      composeCalls += 1;
      assert.equal(request.reason, "scheduled archive writing");
      return {
        kind: "poem",
        title: "星尘",
        content: "第一行\n第二行",
        reason: "recent astronomy observation sparked it",
      };
    },
    writeArchive: async (request) => {
      writeCalls += 1;
      assert.equal(request.kind, "poem");
      assert.equal(request.title, "星尘");
    },
    runGroupProactiveAction: async () => {
      groupCalls += 1;
      return EMPTY_PROACTIVE;
    },
    log: () => {},
    recordWorldObservation: () => {},
  });

  assert.equal(result.action.type, "write_archive");
  assert.equal(composeCalls, 1);
  assert.equal(writeCalls, 1);
  assert.equal(groupCalls, 0);
  assert.equal(state.archiveWritingDailyCount, 1);
  assert.equal(state.lastArchiveWritingAt, NOW);
});

test("autonomy loop skips archive writing when the composer declines", async () => {
  const state = baseState({
    lastWorldObservationAt: NOW - 5 * MIN,
    lastMemoryReflectionAt: NOW - 5 * MIN,
  });
  let writeCalls = 0;
  let groupCalls = 0;

  const result = await runAutonomyLoop({
    now: () => NOW,
    config: baseConfig({ archiveWritingEnabled: true }),
    getState: () => state,
    saveState: async () => {},
    observeWorld: async () => OBSERVATION,
    reflectMemory: async () => null,
    writeMemory: async () => {},
    composeArchive: async () => null,
    writeArchive: async () => {
      writeCalls += 1;
    },
    runGroupProactiveAction: async () => {
      groupCalls += 1;
      return EMPTY_PROACTIVE;
    },
    log: () => {},
    recordWorldObservation: () => {},
  });

  assert.equal(result.action.type, "do_nothing");
  assert.equal(writeCalls, 0);
  assert.equal(groupCalls, 1);
  assert.equal(state.lastArchiveWritingAt, 0);
  assert.equal(state.lastArchiveWritingAttemptAt, NOW);
});

test("autonomy loop falls back to group proactive action when world observation is not due", async () => {
  const state = baseState({ lastWorldObservationAt: NOW - 5 * MIN });
  let observeCalls = 0;
  let groupCalls = 0;
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

  const result = await runAutonomyLoop({
    now: () => NOW,
    config: baseConfig(),
    getState: () => state,
    saveState: async () => {},
    observeWorld: async () => {
      observeCalls += 1;
      return OBSERVATION;
    },
    reflectMemory: async () => null,
    writeMemory: async () => {},
    composeArchive: async () => null,
    writeArchive: async () => {},
    runGroupProactiveAction: async () => {
      groupCalls += 1;
      return groupResult;
    },
    log: () => {},
    recordWorldObservation: () => {},
  });

  assert.equal(result.action.type, "send_group_message");
  assert.equal(observeCalls, 0);
  assert.equal(groupCalls, 1);
});
