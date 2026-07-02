import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_DECISION_PROMPT,
  detectIncompleteFinalAnswer,
} from "../decision-prompt.js";

test("decision prompt tells the model not to end mid-sentence", () => {
  assert.match(MODEL_DECISION_PROMPT, /complete sendable message/);
});

test("detectIncompleteFinalAnswer catches dangling Chinese endings", () => {
  assert.match(
    detectIncompleteFinalAnswer("然后帕秋莉那个问题我觉得跟四色定理不太一样——四色是") ?? "",
    /dangling/,
  );
  assert.match(detectIncompleteFinalAnswer("我想说的是：") ?? "", /dangling/);
  assert.match(detectIncompleteFinalAnswer("这个问题可以换句话说") ?? "", /dangling/);
});

test("detectIncompleteFinalAnswer accepts complete short replies", () => {
  assert.equal(detectIncompleteFinalAnswer("四色定理那个类比戳到点子上了。"), null);
  assert.equal(detectIncompleteFinalAnswer("FrontierMath 真做出来才算推进，不是刷分。"), null);
});
