import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldWarmReplyRoute } from "../context-warm-policy.js";

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
