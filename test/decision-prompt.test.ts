import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_DECISION_PROMPT,
  detectIncompleteFinalAnswer,
  stripGroupReplyPrefix,
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

test("stripGroupReplyPrefix removes mimicked context prefixes", () => {
  assert.equal(stripGroupReplyPrefix("[群20000002] 好啊，明天见"), "好啊，明天见");
  assert.equal(stripGroupReplyPrefix("[群20000002]：好啊"), "好啊");
  assert.equal(stripGroupReplyPrefix("群20000002：好啊"), "好啊");
  assert.equal(stripGroupReplyPrefix("群 20000002: 好啊"), "好啊");
  assert.equal(
    stripGroupReplyPrefix("群聊 [数学群(20000002)] [Holly(10000003)] 这个极限是 0"),
    "这个极限是 0",
  );
  assert.equal(stripGroupReplyPrefix("[Holly(10000003)] 这个极限是 0"), "这个极限是 0");
  assert.equal(stripGroupReplyPrefix("group_id: 20000002 好啊"), "好啊");
});

test("stripGroupReplyPrefix removes stacked prefixes", () => {
  assert.equal(
    stripGroupReplyPrefix("[群20000002] [Holly(10000003)] 好啊"),
    "好啊",
  );
});

test("stripGroupReplyPrefix keeps legitimate replies intact", () => {
  assert.equal(stripGroupReplyPrefix("群里有人已经说过这个了"), "群里有人已经说过这个了");
  assert.equal(stripGroupReplyPrefix("群20000002 是我们数学群的群号"), "群20000002 是我们数学群的群号");
  assert.equal(stripGroupReplyPrefix("[f(x)] 表示取整没问题"), "[f(x)] 表示取整没问题");
  assert.equal(stripGroupReplyPrefix("好啊，明天见"), "好啊，明天见");
  assert.equal(stripGroupReplyPrefix(""), "");
});
