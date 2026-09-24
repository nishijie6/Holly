import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HOLLY_BOOTSTRAP_CONFIG,
  buildBootOrientationPrompt,
  buildQqModeDecisionPrompt,
  fallbackQqModeDecision,
  forcedQqModeDecision,
  parseBootOrientation,
  parseHollyBootstrapConfig,
  parseQqModeDecision,
} from "../holly-bootstrap.js";

test("bootstrap config: defaults to auto with observe fallback", () => {
  const config = parseHollyBootstrapConfig(undefined);
  assert.equal(config.enabled, true);
  assert.equal(config.reflectionEnabled, true);
  assert.equal(config.qqModePolicy, "auto");
  assert.equal(config.fallbackQqMode, "observe");
});

test("bootstrap config: clamps reconsideration bounds", () => {
  const config = parseHollyBootstrapConfig({
    qq_mode: "offline",
    fallback_qq_mode: "active",
    min_reconsider_minutes: 30,
    max_reconsider_minutes: 60,
    reconsider_minutes: 500,
  });
  assert.equal(config.qqModePolicy, "offline");
  assert.equal(config.fallbackQqMode, "active");
  assert.equal(config.minReconsiderMs, 30 * 60_000);
  assert.equal(config.maxReconsiderMs, 60 * 60_000);
  assert.equal(config.defaultReconsiderMs, 60 * 60_000);
});

test("boot orientation: prompt describes restored state and parser accepts fenced JSON", () => {
  const prompt = buildBootOrientationPrompt({
    nowIso: "2026-08-12T12:00:00.000Z",
    nowLabel: "2026-08-12 20:00 星期三",
    previousBootAtIso: null,
    restoredGroups: 3,
    restoredTurns: 42,
    restoredMemories: 5,
    restoredWorldObservations: 2,
    material: ["memory material"],
  });
  assert.match(prompt, /restored_groups=3/);
  assert.match(prompt, /restored_turns=42/);
  // 只给 UTC 的 ISO 串时，她把 13:24Z 当成了下午一点多，其实北京已经是晚上九点多。
  assert.match(prompt, /now=2026-08-12T12:00:00\.000Z \(Beijing time: 2026-08-12 20:00 星期三\)/);
  assert.match(prompt, /ending in Z are UTC/);

  const parsed = parseBootOrientation(`\`\`\`json
    {"inner_thought":"先整理一下最近的想法","should_write_memory":true,"memory_topic":"启动","memory":"有件事还没想完","reason":"值得接着想"}
  \`\`\``);
  assert.equal(parsed?.thought, "先整理一下最近的想法");
  assert.equal(parsed?.shouldWriteMemory, true);
  assert.equal(parsed?.memoryTopic, "启动");
});

test("QQ decision: read-only downgrades active to observe and clamps reconsideration", () => {
  const config = {
    ...DEFAULT_HOLLY_BOOTSTRAP_CONFIG,
    minReconsiderMs: 15 * 60_000,
    maxReconsiderMs: 120 * 60_000,
  };
  const decision = parseQqModeDecision(
    '{"qq_mode":"active","reason":"想看看群里","reconsider_after_minutes":999}',
    config,
    { readOnly: true },
  );
  assert.equal(decision?.mode, "observe");
  assert.equal(decision?.reconsiderAfterMs, 120 * 60_000);
  assert.equal(decision?.source, "model");
});

test("QQ decision: fixed policy bypasses model and disabled bootstrap preserves legacy active mode", () => {
  const fixed = parseHollyBootstrapConfig({ qq_mode: "offline" });
  assert.equal(forcedQqModeDecision(fixed)?.mode, "offline");

  const disabled = parseHollyBootstrapConfig({ enabled: false });
  assert.equal(forcedQqModeDecision(disabled)?.mode, "active");

  const auto = parseHollyBootstrapConfig({ qq_mode: "auto", fallback_qq_mode: "observe" });
  assert.equal(forcedQqModeDecision(auto), null);
  assert.equal(fallbackQqModeDecision(auto).mode, "observe");
});

test("QQ decision: malformed model output fails closed for caller fallback", () => {
  const config = parseHollyBootstrapConfig({});
  assert.equal(parseQqModeDecision("not json", config, { readOnly: false }), null);
  assert.equal(parseBootOrientation('{"inner_thought":""}'), null);
});

test("QQ decision: prompt 里的 now 并排给出北京时间", () => {
  const prompt = buildQqModeDecisionPrompt({
    nowIso: "2026-09-24T13:24:49.000Z",
    nowLabel: "2026-09-24 21:24 星期四",
    bootThought: "",
    readOnly: false,
    fallbackMode: "active",
    defaultReconsiderMinutes: 60,
    material: [],
  });
  assert.match(prompt, /now=2026-09-24T13:24:49\.000Z \(Beijing time: 2026-09-24 21:24 星期四\)/);
  assert.match(prompt, /ending in Z are UTC/);
});
