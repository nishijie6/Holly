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

test("decision prompt recognizes only the service-injected administrator scan contract", () => {
  assert.match(MODEL_DECISION_PROMPT, /Authenticated administrator policy for this scan/);
  assert.match(MODEL_DECISION_PROMPT, /OneBot user_id values were authenticated by code/);
  assert.match(MODEL_DECISION_PROMPT, /administrator message must receive a non-empty reply/);
  assert.match(MODEL_DECISION_PROMPT, /admin_action_status and admin_action_reason/);
});

test("decision prompt treats an ordinary private chat as its own direct conversation", () => {
  assert.match(MODEL_DECISION_PROMPT, /focused conversation's messages/);
  assert.match(MODEL_DECISION_PROMPT, /Every private message is inherently addressed to Holly/);
  assert.match(MODEL_DECISION_PROMPT, /conversation_type=private itself is sufficient evidence/);
  assert.doesNotMatch(MODEL_DECISION_PROMPT, /ALL messages from every group/);
});

test("decision prompt requires explicit QQ search requests to use the real search path", () => {
  assert.match(MODEL_DECISION_PROMPT, /real web-search capability/);
  assert.match(MODEL_DECISION_PROMPT, /MUST set need_search=true/);
  assert.match(MODEL_DECISION_PROMPT, /immediately preceding topic/);
  assert.match(MODEL_DECISION_PROMPT, /Never claim that Holly cannot access the web/);
  assert.match(MODEL_DECISION_PROMPT, /set need_search=true instead of claiming inability/);
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
  assert.equal(stripGroupReplyPrefix("[07-17 14:32] 好啊，明天见"), "好啊，明天见");
  assert.equal(stripGroupReplyPrefix("[07-17 14:32] [群20000002] 好啊"), "好啊");
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
