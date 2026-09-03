import assert from "node:assert/strict";
import test from "node:test";

import { RouteQueue } from "../route-queue.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("two tasks on the same route run strictly in order", async () => {
  const queue = new RouteQueue();
  const order: string[] = [];
  const first = deferred<void>();

  const firstDone = queue.submit("reply:1", async () => {
    order.push("first-start");
    await first.promise;
    order.push("first-end");
  });
  const secondDone = queue.submit("reply:1", async () => {
    order.push("second-start");
  });

  // The second task must not even start while the first is still pending.
  await tick();
  assert.deepEqual(order, ["first-start"]);

  first.resolve();
  await Promise.all([firstDone, secondDone]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("tasks on different routes run concurrently, not queued behind each other", async () => {
  const queue = new RouteQueue();
  const order: string[] = [];
  const groupA = deferred<void>();

  const aDone = queue.submit("reply:A", async () => {
    order.push("a-start");
    await groupA.promise;
    order.push("a-end");
  });
  const bDone = queue.submit("reply:B", async () => {
    order.push("b-start");
    order.push("b-end");
  });

  // B must not wait on A's still-pending route.
  await bDone;
  assert.deepEqual(order, ["a-start", "b-start", "b-end"]);

  groupA.resolve();
  await aDone;
  assert.deepEqual(order, ["a-start", "b-start", "b-end", "a-end"]);
});

test("a route that failed still runs its next submission", async () => {
  const queue = new RouteQueue();
  await assert.rejects(queue.submit("reply:1", async () => {
    throw new Error("boom");
  }));

  const result = await queue.submit("reply:1", async () => "recovered");
  assert.equal(result, "recovered");
});

test("submitExclusive waits for already-queued route work, then blocks new submissions until it finishes", async () => {
  const queue = new RouteQueue();
  const order: string[] = [];
  const groupA = deferred<void>();
  const exclusive = deferred<void>();

  // Already in flight before the exclusive call is made.
  const aDone = queue.submit("reply:A", async () => {
    order.push("a-start");
    await groupA.promise;
    order.push("a-end");
  });
  await tick();

  const exclusiveDone = queue.submitExclusive(async () => {
    order.push("exclusive-start");
    await exclusive.promise;
    order.push("exclusive-end");
  });

  // A new submission arriving while the exclusive task is pending (still
  // waiting on A to drain) must not start until the exclusive task is done.
  const bDone = queue.submit("reply:B", async () => {
    order.push("b-start");
  });

  await tick();
  // Exclusive hasn't started yet: it's still waiting for A's already-queued
  // work to drain.
  assert.deepEqual(order, ["a-start"]);

  groupA.resolve();
  await tick();
  await tick();
  assert.deepEqual(order, ["a-start", "a-end", "exclusive-start"]);
  // B is still blocked behind the exclusive gate.
  assert.ok(!order.includes("b-start"));

  exclusive.resolve();
  await Promise.all([aDone, exclusiveDone, bDone]);
  assert.deepEqual(order, ["a-start", "a-end", "exclusive-start", "exclusive-end", "b-start"]);
});

test("submitExclusive does not wait for work submitted after it started", async () => {
  const queue = new RouteQueue();
  const order: string[] = [];
  const exclusive = deferred<void>();

  const exclusiveDone = queue.submitExclusive(async () => {
    order.push("exclusive-start");
    await exclusive.promise;
    order.push("exclusive-end");
  });
  await tick();

  // Submitted after the exclusive call began: must queue behind it, not run
  // alongside it or get folded into its wait set.
  const laterDone = queue.submit("reply:C", async () => {
    order.push("later-start");
  });

  await tick();
  assert.deepEqual(order, ["exclusive-start"]);

  exclusive.resolve();
  await Promise.all([exclusiveDone, laterDone]);
  assert.deepEqual(order, ["exclusive-start", "exclusive-end", "later-start"]);
});

test("two exclusive calls serialize against each other rather than overlapping", async () => {
  const queue = new RouteQueue();
  const order: string[] = [];
  const first = deferred<void>();

  const firstDone = queue.submitExclusive(async () => {
    order.push("first-start");
    await first.promise;
    order.push("first-end");
  });
  await tick();

  const secondDone = queue.submitExclusive(async () => {
    order.push("second-start");
  });
  await tick();
  assert.deepEqual(order, ["first-start"]);

  first.resolve();
  await Promise.all([firstDone, secondDone]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});
