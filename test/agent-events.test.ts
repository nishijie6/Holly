import assert from "node:assert/strict";
import test from "node:test";

import { AgentEventQueue } from "../agent-events.js";

// 队列的性质，不是分发器的性质：push 只入队并唤醒，取和执行全归消费循环。
// 下面钉的三件事——按序、一次取干净、唤醒不丢——是那个循环能成立的全部前提。

test("takeAll 按入队顺序一次取干净", () => {
  const queue = new AgentEventQueue();
  queue.push({ type: "message_batch_ready", groupKey: "A" });
  queue.push({ type: "message_batch_ready", groupKey: "B" });
  queue.push({ type: "autonomy_tick_due" });

  assert.deepEqual(queue.takeAll(), [
    { type: "message_batch_ready", groupKey: "A" },
    { type: "message_batch_ready", groupKey: "B" },
    { type: "autonomy_tick_due" },
  ]);
  assert.equal(queue.pending, 0);
  assert.deepEqual(queue.takeAll(), [], "取过之后就空了，同一个事件不会被消费两次");
});

test("队列非空时 waitNonEmpty 立刻返回", async () => {
  const queue = new AgentEventQueue();
  queue.push({ type: "autonomy_tick_due" });
  await queue.waitNonEmpty();
  assert.equal(queue.pending, 1);
});

// 消费循环空转的唯一方式就是挂在这里。挂不住就会变成忙等，挂住了醒不来就是彻底停摆。
test("空队列时 waitNonEmpty 挂起，push 把它唤醒", async () => {
  const queue = new AgentEventQueue();
  let woke = false;
  const waiting = queue.waitNonEmpty().then(() => { woke = true; });

  await Promise.resolve();
  assert.equal(woke, false, "还没有人 push，不该醒");

  queue.push({ type: "autonomy_tick_due" });
  await waiting;
  assert.equal(woke, true);
});

test("一次 push 唤醒所有等待者", async () => {
  const queue = new AgentEventQueue();
  const waits = [queue.waitNonEmpty(), queue.waitNonEmpty(), queue.waitNonEmpty()];
  queue.push({ type: "autonomy_tick_due" });
  await Promise.all(waits);
  assert.equal(queue.pending, 1, "唤醒不消费；取还是取一次");
});

// 攒着的事件要能被一起看见——Step 2 的合并全靠这个，一个一个取就没得合并了。
test("消费者忙的时候攒下的事件，一次全拿到", () => {
  const queue = new AgentEventQueue();
  queue.push({ type: "message_batch_ready", groupKey: "A" });
  queue.push({ type: "message_batch_ready", groupKey: "A" });
  queue.push({ type: "message_batch_ready", groupKey: "B" });
  queue.push({ type: "autonomy_tick_due" });

  assert.equal(queue.takeAll().length, 4);
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

// 监控面板记的是「推进来过什么」，和有没有被消费无关。
test("takeAll 之后 recent() 里那些事件还在", () => {
  const queue = new AgentEventQueue();
  queue.push({ type: "message_batch_ready", groupKey: "A" });
  queue.takeAll();
  assert.equal(queue.recent().length, 1);
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
