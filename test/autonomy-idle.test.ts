import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTONOMY_IDLE_POLICY,
  evaluateAutonomyTrigger,
  getBeijingHour,
  type AutonomyIdlePolicy,
} from "../autonomy-idle.js";

const MIN = 60 * 1000;
// 北京时间 20 点，在静默窗之外——除非某个用例特意去测夜里。
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

const POLICY: AutonomyIdlePolicy = {
  judgmentCooldownMs: 15 * MIN,
  focusIdleMs: 5 * MIN,
  quietStartHour: 1,
  quietEndHour: 9,
};

function verdict(signals: { lastJudgmentAt?: number; lastFocusActivityAt?: number }, now = NOW) {
  return evaluateAutonomyTrigger({
    now,
    signals: {
      lastJudgmentAt: signals.lastJudgmentAt ?? 0,
      lastFocusActivityAt: signals.lastFocusActivityAt ?? 0,
    },
    policy: POLICY,
  });
}

test("没问过、群里也没动静，就问", () => {
  assert.deepEqual(verdict({}), { ask: true });
});

// 这是整个门控的重点：她正跟人说着话的时候，不该被拉去想自己的事。以前这个循环每分钟
// 都在问，哪怕她刚发完一条消息。
test("她刚在群里说过话，先不打断", () => {
  const result = verdict({ lastFocusActivityAt: NOW - 1 * MIN });
  assert.equal(result.ask, false);
  assert.match((result as { reason: string }).reason, /正忙着/);
});

test("安静够久就算闲下来了", () => {
  assert.deepEqual(verdict({ lastFocusActivityAt: NOW - 6 * MIN }), { ask: true });
});

test("刚问过就等不应期，别每分钟都问一次", () => {
  const result = verdict({ lastJudgmentAt: NOW - 3 * MIN });
  assert.equal(result.ask, false);
  assert.match((result as { reason: string }).reason, /不应期/);
});

test("不应期过了就能再问", () => {
  assert.deepEqual(verdict({ lastJudgmentAt: NOW - 16 * MIN }), { ask: true });
});

// 跟 kagami 一致：凌晨一点到早上九点不起这个念头。
test("夜里不问", () => {
  // 北京时间凌晨 3 点。
  const night = Date.UTC(2026, 0, 1, 19, 0, 0);
  const result = verdict({}, night);
  assert.equal(result.ask, false);
  assert.match((result as { reason: string }).reason, /夜里/);
});

test("静默窗结束就恢复", () => {
  // 北京时间上午 9 点整，窗口右端不含。
  const morning = Date.UTC(2026, 0, 1, 1, 0, 0);
  assert.equal(getBeijingHour(new Date(morning)), 9);
  assert.deepEqual(verdict({}, morning), { ask: true });
});

// 重启后这两个信号都归零。宁可早一步问，也不要因为不知道就把她按在原地。
test("信号为零按闲处理，不是按忙", () => {
  assert.deepEqual(verdict({ lastJudgmentAt: 0, lastFocusActivityAt: 0 }), { ask: true });
});

test("挡下时给得出什么时候能再问", () => {
  const result = verdict({ lastFocusActivityAt: NOW - 1 * MIN });
  assert.equal((result as { nextEligibleAt: number | null }).nextEligibleAt, NOW - 1 * MIN + 5 * MIN);
});

test("默认参数就是 kagami 那套作息", () => {
  assert.equal(AUTONOMY_IDLE_POLICY.quietStartHour, 1);
  assert.equal(AUTONOMY_IDLE_POLICY.quietEndHour, 9);
});
