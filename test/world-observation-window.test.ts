import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OBSERVATION_WINDOW_OPTIONS,
  selectObservationWindow,
} from "../world-observation-window.js";

// 这里钉的是「什么时候允许前缀变」。记忆反思那半段素材是缓存断点前面的东西，它每变一次
// 就是整段前缀按未缓存全价重读一遍——旧实现每次调用都按当前时间重算窗口，于是两次反思
// 之间什么都没发生也会变。滞后窗口的全部意义就是把「变」压缩成偶尔一次的计划动作。

const OPTIONS = { lowWater: 3, highWater: 6 };
const obs = (observedAtMs: number) => ({ observedAtMs });
const many = (count: number) => Array.from({ length: count }, (_, i) => obs(1000 + i));

test("默认参数是 6/12：稳态留 6 条，涨到 12 条才重建一次", () => {
  assert.equal(DEFAULT_OBSERVATION_WINDOW_OPTIONS.lowWater, 6);
  assert.equal(DEFAULT_OBSERVATION_WINDOW_OPTIONS.highWater, 12);
});

test("没到高水位就原样返回，窗口起点纹丝不动", () => {
  const result = selectObservationWindow(many(6), 0, OPTIONS);
  assert.equal(result.window.length, 6);
  assert.equal(result.fromMs, 0);
  assert.equal(result.compacted, false);
});

test("时间流逝本身不推窗口——同一批观察调多少次结果都一样", () => {
  const items = many(5);
  const first = selectObservationWindow(items, 0, OPTIONS);
  const second = selectObservationWindow(items, first.fromMs, OPTIONS);
  const third = selectObservationWindow(items, second.fromMs, OPTIONS);
  // 这一条正是旧实现做不到的：它按 now 现算 24h 窗口，等得够久同样的输入会给出更短的输出。
  assert.deepEqual(second.window, first.window);
  assert.deepEqual(third.window, first.window);
  assert.equal(third.compacted, false);
});

test("只追加时前缀只增不改：老条目在新结果里原样靠前", () => {
  const items = many(4);
  const before = selectObservationWindow(items, 0, OPTIONS);
  const after = selectObservationWindow([...items, obs(2000)], before.fromMs, OPTIONS);
  assert.equal(after.compacted, false);
  // 追加一条之后，前面每一条还在原来的位置上——这就是 cache 能 extend 的条件。
  assert.deepEqual(after.window.slice(0, before.window.length), before.window);
  assert.equal(after.window.length, before.window.length + 1);
});

test("超过高水位才重建一次，且一次裁到低水位", () => {
  const result = selectObservationWindow(many(7), 0, OPTIONS);
  assert.equal(result.compacted, true);
  assert.equal(result.window.length, OPTIONS.lowWater);
  // 保留的是最新的那几条。
  assert.deepEqual(result.window.map((i) => i.observedAtMs), [1004, 1005, 1006]);
});

test("重建后的新起点取自保留段自己的时间戳，不含任何「现在」", () => {
  const result = selectObservationWindow(many(7), 0, OPTIONS);
  assert.equal(result.fromMs, 1004);
  // 拿新起点再问一次，应当稳定下来不再重建——否则就是每轮都在压缩。
  const next = selectObservationWindow(many(7), result.fromMs, OPTIONS);
  assert.equal(next.compacted, false);
  assert.deepEqual(next.window, result.window);
});

test("一次重建换来若干轮免费的追加", () => {
  let fromMs = 0;
  let compactions = 0;
  const items = [...many(7)];
  for (let i = 0; i < 4; i += 1) {
    const result = selectObservationWindow(items, fromMs, OPTIONS);
    fromMs = result.fromMs;
    if (result.compacted) compactions += 1;
    items.push(obs(2000 + i));
  }
  // 7 条触发一次重建裁到 3 条，之后追加 3 条到 6 条都还在高水位内。
  assert.equal(compactions, 1);
});

test("起点之前的条目不会因为还留在数组里就回来", () => {
  const items = many(7);
  const compacted = selectObservationWindow(items, 0, OPTIONS);
  // 数组本身没变短（128 条上限比这个窗口宽），但被划出去的条目不该再出现。
  const again = selectObservationWindow(items, compacted.fromMs, OPTIONS);
  assert.equal(again.window.length, OPTIONS.lowWater);
  assert.equal(again.window.every((i) => i.observedAtMs >= compacted.fromMs), true);
});

test("上游把老条目裁掉后不会算错，也不会凭空重建", () => {
  const compacted = selectObservationWindow(many(7), 0, OPTIONS);
  // rememberWorldObservation 的 24h / 128 条裁剪会从数组头部删元素。
  const trimmed = many(7).filter((i) => i.observedAtMs >= 1005);
  const result = selectObservationWindow(trimmed, compacted.fromMs, OPTIONS);
  assert.equal(result.compacted, false);
  assert.equal(result.window.length, 2);
});

test("空输入不炸，起点保持原样", () => {
  const result = selectObservationWindow([], 1234, OPTIONS);
  assert.deepEqual(result.window, []);
  assert.equal(result.fromMs, 1234);
  assert.equal(result.compacted, false);
});

test("荒唐的参数被夹回可用范围，不会返回空窗口", () => {
  const result = selectObservationWindow(many(10), 0, { lowWater: 0, highWater: -5 });
  assert.equal(result.window.length, 1);
  assert.equal(result.compacted, true);
});

test("highWater 小于 lowWater 时以 lowWater 为准", () => {
  const result = selectObservationWindow(many(10), 0, { lowWater: 4, highWater: 2 });
  assert.equal(result.window.length, 4);
});
