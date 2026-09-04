import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_FOCUS_MODE_CONFIG, parseFocusModeConfig } from "../focus-mode-config.js";

// This flag is the rollback mechanism for the whole pipeline migration, so its
// failure modes matter more than its happy path: a malformed config must land on
// the old pipeline, never leave Holly half-switched.

test("a missing section keeps the focus pipeline off", () => {
  assert.deepEqual(parseFocusModeConfig(undefined), DEFAULT_FOCUS_MODE_CONFIG);
  assert.equal(parseFocusModeConfig(undefined).enabled, false);
});

test("junk in place of the section degrades to the defaults, not a throw", () => {
  for (const junk of [null, "yes", 42, [], true]) {
    assert.equal(parseFocusModeConfig(junk).enabled, false, `for ${JSON.stringify(junk)}`);
  }
});

test("enabled must be a real boolean, not a truthy string", () => {
  // A YAML "enabled: 'true'" typo must not silently switch pipelines.
  assert.equal(parseFocusModeConfig({ enabled: "true" }).enabled, false);
  assert.equal(parseFocusModeConfig({ enabled: 1 }).enabled, false);
  assert.equal(parseFocusModeConfig({ enabled: true }).enabled, true);
});

test("round and turn limits are read when sane", () => {
  const config = parseFocusModeConfig({ enabled: true, max_rounds: 4, recent_turns_per_conversation: 50 });
  assert.deepEqual(config, { enabled: true, maxRounds: 4, recentTurnsPerConversation: 50 });
});

test("limits are clamped rather than trusted", () => {
  // A runaway ceiling is expensive: every round re-sends the whole ledger.
  assert.equal(parseFocusModeConfig({ max_rounds: 0 }).maxRounds, 1);
  assert.equal(parseFocusModeConfig({ max_rounds: 9999 }).maxRounds, 30);
  assert.equal(parseFocusModeConfig({ recent_turns_per_conversation: 1 }).recentTurnsPerConversation, 5);
  assert.equal(parseFocusModeConfig({ recent_turns_per_conversation: 100_000 }).recentTurnsPerConversation, 200);
});

test("non-numeric limits fall back instead of producing NaN", () => {
  const config = parseFocusModeConfig({ max_rounds: "八", recent_turns_per_conversation: null });
  assert.equal(config.maxRounds, DEFAULT_FOCUS_MODE_CONFIG.maxRounds);
  assert.equal(config.recentTurnsPerConversation, DEFAULT_FOCUS_MODE_CONFIG.recentTurnsPerConversation);
});

test("fractional limits are floored to whole rounds", () => {
  assert.equal(parseFocusModeConfig({ max_rounds: 6.9 }).maxRounds, 6);
});
