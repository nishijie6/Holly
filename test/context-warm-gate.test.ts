import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONTEXT_WARM_CONFIG,
  parseContextWarmConfig,
  shouldWarmReplyRoute,
} from "../context-warm-policy.js";

// Which groups earn a context warm. A warm writes the group's prefix at 2x base
// input (1h TTL) and only pays off if a reply or proactive decision reads it
// back at 0.1x before it expires — so "this group received messages" is not
// enough, and warming on that alone measured out as a net loss.

const WINDOW = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

test("a group whose route was never read is not warmed", () => {
  assert.equal(shouldWarmReplyRoute(undefined, NOW, WINDOW), false);
});

test("a group read just now is warmed", () => {
  assert.equal(shouldWarmReplyRoute(NOW, NOW, WINDOW), true);
});

test("a group read inside the window is warmed", () => {
  assert.equal(shouldWarmReplyRoute(NOW - 20 * 60 * 1000, NOW, WINDOW), true);
});

test("the window boundary still warms", () => {
  assert.equal(shouldWarmReplyRoute(NOW - WINDOW, NOW, WINDOW), true);
});

test("a group last read past the window goes cold", () => {
  assert.equal(shouldWarmReplyRoute(NOW - WINDOW - 1, NOW, WINDOW), false);
  assert.equal(shouldWarmReplyRoute(NOW - 6 * WINDOW, NOW, WINDOW), false);
});

test("a clock that moved backwards does not read as stale", () => {
  // A read timestamped after `now` (clock adjustment, or a read recorded during
  // this same pass) yields a negative age, which must not fall outside the window.
  assert.equal(shouldWarmReplyRoute(NOW + 5_000, NOW, WINDOW), true);
});

// 总开关。闸门决定「哪个群值得预热」，开关决定「现在还预不预热」。默认开：按当前
// 计费口径 cache write 不收溢价，预热那笔写是免费的（理由写在 context-warm-policy.ts
// 的 ContextWarmConfig 上面）。这几条钉的是解析行为本身，不是那个默认值的对错——
// 溢价要是回来了，改的是默认值和这里的第一条断言，其余三条不动。

test("默认开：没有配置时预热", () => {
  assert.equal(parseContextWarmConfig(undefined).enabled, true);
  assert.equal(DEFAULT_CONTEXT_WARM_CONFIG.enabled, true);
});

test("显式关得掉，显式开也认", () => {
  assert.equal(parseContextWarmConfig({ enabled: false }).enabled, false);
  assert.equal(parseContextWarmConfig({ enabled: true }).enabled, true);
});

test("非布尔值不当成一个决定，退回默认", () => {
  for (const value of ["false", 0, null, [], {}]) {
    assert.equal(parseContextWarmConfig({ enabled: value }).enabled, DEFAULT_CONTEXT_WARM_CONFIG.enabled);
  }
});

test("整段配置写错类型也退回默认，不抛错", () => {
  for (const value of [null, "context_warm", 42, []]) {
    assert.equal(parseContextWarmConfig(value).enabled, DEFAULT_CONTEXT_WARM_CONFIG.enabled);
  }
});
