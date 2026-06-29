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
    maxWorldObservationsPerDay: 3,
    worldTopics: ["AI latest", "astronomy latest"],
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
    ...overrides,
  };
}

const OBSERVATION: ProactiveWorldObservation = {
  query: "AI latest",
  summary: "Browser observation summary",
  urls: ["https://example.com/ai"],
};

const EMPTY_PROACTIVE: ProactiveTickResult = { actions: [] };

test("autonomy loop observes the world before group proactive work when due", async () => {
  const state = baseState();
  let observeCalls = 0;
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
    runGroupProactiveAction: async () => {
      groupCalls += 1;
      return EMPTY_PROACTIVE;
    },
    log: () => {},
    recordWorldObservation: (record) => records.push(record),
  });

  assert.equal(result.action.type, "observe_world");
  assert.equal(observeCalls, 1);
  assert.equal(groupCalls, 0);
  assert.equal(state.worldObservationDailyCount, 1);
  assert.equal(state.lastWorldObservationAt, NOW);
  assert.equal(state.nextWorldTopicIndex, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].ok, true);
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
