import assert from "node:assert/strict";
import test from "node:test";

import {
  buildArchiveCompositionPrompt,
  buildMemoryReflectionPrompt,
} from "../autonomy-prompts.js";

const worldBlocks = [
  "World observation 1:\n- topic: 天文学\n- summary: 一些内容",
  "World observation 2:\n- topic: 数学趣题\n- summary: 另一些内容",
];
const churn = ["Internal memory 1:\n- content: 刚写下的记忆", "Recent conversation:\n- 有人说了句话"];

// The whole point of the split: two ticks that see the same world-observation
// window must produce byte-identical stable halves, or the cache entry the
// breakpoint creates is dead on arrival.
test("memory reflection's stable half is byte-identical across ticks", () => {
  const first = buildMemoryReflectionPrompt("2026-09-06T13:00:00.000Z", "tick", worldBlocks, churn);
  const second = buildMemoryReflectionPrompt(
    "2026-09-06T13:33:00.000Z",
    "another tick",
    worldBlocks,
    [...churn, "Internal memory 2:\n- content: 又一条"],
  );

  assert.equal(first.stable, second.stable);
  assert.notEqual(first.volatile, second.volatile);
});

// now/reason used to sit ahead of the material. A timestamp anywhere in the
// prefix invalidates everything after it, so this is the regression that would
// silently undo the split while every test about content still passed.
test("timestamps stay out of the cached half", () => {
  const nowIso = "2026-09-06T13:00:00.000Z";
  const memory = buildMemoryReflectionPrompt(nowIso, "tick", worldBlocks, churn);
  assert.ok(!memory.stable.includes(nowIso), "now must not appear in the stable half");
  assert.ok(!memory.stable.includes("reason="), "reason must not appear in the stable half");
  assert.ok(memory.volatile.includes(nowIso));

  const archive = buildArchiveCompositionPrompt(nowIso, "tick", ["- [poem] 旧作"], worldBlocks, churn);
  assert.ok(!archive.stable.includes(nowIso), "now must not appear in the stable half");
  assert.ok(archive.volatile.includes(nowIso));
});

// Recent titles grow every time Holly writes, so they belong with the churn.
test("archive composition keeps recent titles in the volatile half", () => {
  const withTitles = buildArchiveCompositionPrompt(
    "2026-09-06T13:00:00.000Z", "tick", ["- [poem] 雨夜"], worldBlocks, churn,
  );
  const withoutTitles = buildArchiveCompositionPrompt(
    "2026-09-06T13:00:00.000Z", "tick", [], worldBlocks, churn,
  );

  assert.equal(withTitles.stable, withoutTitles.stable, "a new work must not disturb the prefix");
  assert.ok(withTitles.volatile.includes("雨夜"));
  assert.ok(!withoutTitles.volatile.includes("Recent works"));
});

// Both halves still have to carry the instructions and the material the model
// needs — a split that drops content would cache beautifully and answer badly.
test("the split preserves instructions and material", () => {
  const { stable, volatile } = buildMemoryReflectionPrompt(
    "2026-09-06T13:00:00.000Z", "tick", worldBlocks, churn,
  );
  assert.ok(stable.includes("Holly's private memory and reflection loop"));
  assert.ok(stable.includes("should_write"));
  for (const block of worldBlocks) assert.ok(stable.includes(block));
  for (const block of churn) assert.ok(volatile.includes(block));
});

// An empty world-observation window is normal at boot and after a quiet day.
test("an empty stable half degrades to instructions only", () => {
  const { stable, volatile } = buildMemoryReflectionPrompt(
    "2026-09-06T13:00:00.000Z", "tick", [], churn,
  );
  assert.ok(stable.includes("Holly's private memory and reflection loop"));
  assert.ok(!stable.endsWith("\n"), "no trailing blank line when there is no material");
  for (const block of churn) assert.ok(volatile.includes(block));
});
