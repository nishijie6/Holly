import assert from "node:assert/strict";
import test from "node:test";

import { AgentEventQueue, type AgentEvent } from "../agent-events.js";

test("events dispatch to a handler in push order", () => {
  const queue = new AgentEventQueue();
  const seen: AgentEvent[] = [];
  queue.onEvent((event) => seen.push(event));

  queue.push({ type: "message_batch_ready", groupKey: "A" });
  queue.push({ type: "message_batch_ready", groupKey: "B" });
  queue.push({ type: "autonomy_tick_due" });

  assert.deepEqual(seen, [
    { type: "message_batch_ready", groupKey: "A" },
    { type: "message_batch_ready", groupKey: "B" },
    { type: "autonomy_tick_due" },
  ]);
});

test("every registered handler sees every event", () => {
  const queue = new AgentEventQueue();
  const seenByFirst: AgentEvent[] = [];
  const seenBySecond: AgentEvent[] = [];
  queue.onEvent((event) => seenByFirst.push(event));
  queue.onEvent((event) => seenBySecond.push(event));

  queue.push({ type: "autonomy_tick_due" });

  assert.equal(seenByFirst.length, 1);
  assert.equal(seenBySecond.length, 1);
});

test("a handler that throws does not stop the next handler for the same event", () => {
  const queue = new AgentEventQueue();
  const seenBySecond: AgentEvent[] = [];
  queue.onEvent(() => {
    throw new Error("boom");
  });
  queue.onEvent((event) => seenBySecond.push(event));

  assert.doesNotThrow(() => queue.push({ type: "autonomy_tick_due" }));
  assert.equal(seenBySecond.length, 1);
});

test("a handler that throws does not stop the next pushed event from dispatching", () => {
  const queue = new AgentEventQueue();
  let calls = 0;
  queue.onEvent((event) => {
    calls += 1;
    if (event.type === "message_batch_ready") {
      throw new Error("boom");
    }
  });

  queue.push({ type: "message_batch_ready", groupKey: "A" });
  queue.push({ type: "autonomy_tick_due" });

  assert.equal(calls, 2);
});

test("recent() returns events oldest-first within the requested window", () => {
  const queue = new AgentEventQueue();
  queue.push({ type: "message_batch_ready", groupKey: "A" });
  queue.push({ type: "message_batch_ready", groupKey: "B" });
  queue.push({ type: "message_batch_ready", groupKey: "C" });

  const last2 = queue.recent(2);
  assert.deepEqual(last2.map((entry) => entry.event), [
    { type: "message_batch_ready", groupKey: "B" },
    { type: "message_batch_ready", groupKey: "C" },
  ]);
});

test("recent() drops the oldest entries once the bounded history fills up", () => {
  const queue = new AgentEventQueue();
  for (let i = 0; i < 210; i += 1) {
    queue.push({ type: "message_batch_ready", groupKey: String(i) });
  }

  const all = queue.recent(1000);
  assert.equal(all.length, 200);
  // The oldest 10 (0..9) were evicted; the log starts at 10.
  assert.equal(all[0]?.event.type, "message_batch_ready");
  assert.equal((all[0]?.event as { groupKey: string }).groupKey, "10");
  assert.equal((all[all.length - 1]?.event as { groupKey: string }).groupKey, "209");
});

test("recent() timestamps come from the injected clock", () => {
  let now = 1_000;
  const queue = new AgentEventQueue(() => now);
  queue.push({ type: "autonomy_tick_due" });
  now = 2_000;
  queue.push({ type: "autonomy_tick_due" });

  const [first, second] = queue.recent();
  assert.equal(first?.at, 1_000);
  assert.equal(second?.at, 2_000);
});
