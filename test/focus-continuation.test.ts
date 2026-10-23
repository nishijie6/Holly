import assert from "node:assert/strict";
import test from "node:test";
import { AgentEventQueue } from "../agent-events.js";
import { ConversationLedger } from "../conversation-ledger.js";
import { LedgerCompactor } from "../ledger-compaction.js";
import { FocusContinuation } from "../focus-continuation.js";

test("a deferred focus request wakes the event loop after backoff without a new message or duplicate injection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const events = new AgentEventQueue();
  const work = new FocusContinuation<string>(() => events.push({ type: "focus_retry_due" }), 1000);
  const ledger = new ConversationLedger();
  ledger.restore([{ role: "user", content: "old facts ".repeat(3000) }]);
  ledger.appendUserText("@Holly please answer");
  work.append("request-already-injected");
  const before = [...ledger.snapshot()];
  const compactor = new LedgerCompactor({ retryMs: 1000 });
  const options = { thresholdTokens: 1000, keepRatio: 0.25 };
  await assert.rejects(compactor.prepare(ledger, async () => { throw new Error("fetch failed"); }, options));
  work.defer();
  work.defer();
  t.mock.timers.tick(999);
  assert.deepEqual(events.takeAll(), []);
  t.mock.timers.tick(1);
  assert.deepEqual(events.takeAll(), [{ type: "focus_retry_due" }]);
  assert.deepEqual(work.snapshot(), ["request-already-injected"]);
  assert.deepEqual(ledger.snapshot(), before);
  assert.equal((await compactor.prepare(ledger, async () => "## 持续背景\n- old facts retained", options)).ready, true);
  assert.equal(ledger.snapshot().filter((turn) => turn.content === "@Holly please answer").length, 1);
  work.clear();
  assert.deepEqual(work.snapshot(), []);
  t.mock.timers.tick(2000);
  assert.deepEqual(events.takeAll(), []);
});

test("completing or suppressing a pending focus round cancels its retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let wakeups = 0;
  const work = new FocusContinuation<string>(() => { wakeups++; }, 1000);
  work.append("already-injected");
  work.defer();
  work.clear();
  t.mock.timers.tick(1000);
  assert.equal(wakeups, 0);
  assert.deepEqual(work.snapshot(), []);
});
