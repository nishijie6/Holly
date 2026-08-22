import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatModelReplyEntry,
  keepTextAfterLastMarker,
  parseModelDecision,
  readAdminActionStatus,
  readDecisionText,
  sanitizeFinalAnswer,
  sanitizeThinkingProcess,
  unwrapJsonBlock,
  type ModelDecision,
} from "../model-decision.js";

// These are characterization tests: they pin the behaviour this code had when
// it was extracted from main.ts, including behaviour that looks wrong. Where a
// case is suspicious it is marked SUSPECT and tracked separately. Do not
// "fix" the code to make one of these pass differently without deciding that
// the change is intended.

// --- unwrapJsonBlock ---

test("unwrapJsonBlock strips a fenced code block", () => {
  assert.equal(unwrapJsonBlock('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unwrapJsonBlock('```\n{"a":1}\n```'), '{"a":1}');
});

test("unwrapJsonBlock slices from the first brace to the last", () => {
  assert.equal(unwrapJsonBlock('prose {"a":1} trailing'), '{"a":1}');
});

test("unwrapJsonBlock returns trimmed input when there is no object", () => {
  assert.equal(unwrapJsonBlock("  plain text  "), "plain text");
});

// --- readDecisionText ---

test("readDecisionText joins string arrays with a semicolon and drops non-strings", () => {
  assert.equal(readDecisionText(["a", 1, "b"]), "a; b");
});

test("readDecisionText trims strings and maps anything else to empty", () => {
  assert.equal(readDecisionText("  hi  "), "hi");
  assert.equal(readDecisionText(42), "");
  assert.equal(readDecisionText(null), "");
  assert.equal(readDecisionText(undefined), "");
});

// --- keepTextAfterLastMarker ---

test("keepTextAfterLastMarker keeps only what follows the final marker", () => {
  assert.equal(keepTextAfterLastMarker("a X b X c", /X/g), "c");
});

test("keepTextAfterLastMarker returns the input untouched when the marker is absent", () => {
  assert.equal(keepTextAfterLastMarker("abc", /X/g), "abc");
});

// --- sanitizeFinalAnswer ---

test("sanitizeFinalAnswer keeps the text after the last final-answer marker", () => {
  assert.equal(sanitizeFinalAnswer("final_answer: first\nfinal_answer: last"), "last");
  assert.equal(sanitizeFinalAnswer("最终回答：你好"), "你好");
});

test("sanitizeFinalAnswer drops a leading thinking-process block", () => {
  assert.equal(
    sanitizeFinalAnswer("思考过程：\n- 要点一\n- 要点二\n真正的回复内容"),
    "真正的回复内容",
  );
});

test("sanitizeFinalAnswer strips a leaked should_reply line", () => {
  assert.equal(sanitizeFinalAnswer("answer: true\n真正的回复"), "真正的回复");
});

test("sanitizeFinalAnswer strips group tags the model mimicked", () => {
  assert.equal(sanitizeFinalAnswer("[群123456] 你好"), "你好");
  assert.equal(sanitizeFinalAnswer("群聊 [a] [b] 你好"), "你好");
});

test("sanitizeFinalAnswer maps blank input to an empty string", () => {
  assert.equal(sanitizeFinalAnswer("   "), "");
});

// --- sanitizeThinkingProcess ---

test("sanitizeThinkingProcess strips a leading label and trims", () => {
  assert.equal(sanitizeThinkingProcess("思考过程：想了想"), "想了想");
  assert.equal(sanitizeThinkingProcess("  就这样  "), "就这样");
});

// --- readAdminActionStatus ---

test("readAdminActionStatus accepts exactly the four contract values", () => {
  for (const value of ["not_a_command", "accepted", "completed", "cannot_comply"]) {
    assert.equal(readAdminActionStatus(value), value);
  }
});

test("readAdminActionStatus maps anything else to null", () => {
  assert.equal(readAdminActionStatus("bogus"), null);
  assert.equal(readAdminActionStatus(null), null);
  assert.equal(readAdminActionStatus(undefined), null);
  assert.equal(readAdminActionStatus(true), null);
});

// --- parseModelDecision ---

test("parseModelDecision reads a well-formed decision", () => {
  const d = parseModelDecision('{"should_reply":true,"final_answer":"hi"}');
  assert.equal(d.shouldReply, true);
  assert.equal(d.finalAnswer, "hi");
  assert.equal(d.adminActionStatus, null);
});

test("parseModelDecision accepts should_reply, shouldReply, and reply as aliases", () => {
  for (const key of ["should_reply", "shouldReply", "reply"]) {
    const d = parseModelDecision(`{"${key}":true,"final_answer":"hi"}`);
    assert.equal(d.shouldReply, true, `${key} should be honoured`);
  }
});

test("parseModelDecision accepts the string \"true\" as an affirmative", () => {
  // Tolerated on purpose: models sometimes return a stringified boolean.
  assert.equal(parseModelDecision('{"should_reply":"true"}').shouldReply, true);
  assert.equal(parseModelDecision('{"shouldReply":"true"}').shouldReply, true);
});

test("parseModelDecision does NOT accept an uppercase \"TRUE\" (SUSPECT)", () => {
  // SUSPECT: the string comparison is case-sensitive, so a model that answers
  // "TRUE" is read as a refusal to reply. Pinned as-is; see the tracking issue
  // before changing this.
  assert.equal(parseModelDecision('{"should_reply":"TRUE"}').shouldReply, false);
});

test("parseModelDecision treats the string \"false\" as negative", () => {
  assert.equal(parseModelDecision('{"should_reply":"false"}').shouldReply, false);
});

test("parseModelDecision unwraps a fenced block and ignores surrounding prose", () => {
  assert.equal(
    parseModelDecision('```json\n{"should_reply":true,"final_answer":"hi"}\n```').finalAnswer,
    "hi",
  );
  assert.equal(
    parseModelDecision('Sure!\n{"should_reply":true,"final_answer":"hi"}\nDone.').finalAnswer,
    "hi",
  );
});

test("parseModelDecision joins an array final_answer", () => {
  assert.equal(
    parseModelDecision('{"should_reply":true,"final_answer":["a","b"]}').finalAnswer,
    "a; b",
  );
});

test("parseModelDecision defaults a missing final_answer to an empty string", () => {
  const d = parseModelDecision('{"should_reply":true}');
  assert.equal(d.finalAnswer, "");
  assert.equal(d.thinkingProcess, "");
});

test("parseModelDecision reads the thinking process under any of its aliases", () => {
  for (const key of [
    "thinking_process",
    "thinkingProcess",
    "reasoning_summary",
    "reasoningSummary",
    "thought_summary",
    "thoughtSummary",
  ]) {
    const d = parseModelDecision(`{"should_reply":true,"${key}":"想了想"}`);
    assert.equal(d.thinkingProcess, "想了想", `${key} should be honoured`);
  }
});

test("parseModelDecision drops an admin_action_status outside the contract", () => {
  assert.equal(
    parseModelDecision('{"should_reply":true,"admin_action_status":"bogus"}').adminActionStatus,
    null,
  );
  assert.equal(
    parseModelDecision('{"should_reply":true,"admin_action_status":"accepted"}').adminActionStatus,
    "accepted",
  );
});

test("parseModelDecision preserves the raw response", () => {
  const raw = '{"should_reply":true,"final_answer":"hi"}';
  assert.equal(parseModelDecision(raw).raw, raw);
});

test("parseModelDecision throws on invalid JSON", () => {
  assert.throws(() => parseModelDecision("not json at all"), /not valid JSON/);
});

test("parseModelDecision throws when the payload is not an object", () => {
  assert.throws(() => parseModelDecision("[1,2,3]"), /must be a JSON object/);
  assert.throws(() => parseModelDecision("null"), /must be a JSON object/);
});

// --- formatModelReplyEntry ---

const decision = (over: Partial<ModelDecision> = {}): ModelDecision => ({
  shouldReply: true,
  finalAnswer: "hi",
  thinkingProcess: "t",
  adminActionStatus: null,
  adminActionReason: "",
  raw: "",
  ...over,
});

test("formatModelReplyEntry marks a sendable reply as pending", () => {
  assert.match(formatModelReplyEntry(decision()), /回复状态: 待发送/);
});

test("formatModelReplyEntry explains a skip when the model declined", () => {
  const out = formatModelReplyEntry(decision({ shouldReply: false, finalAnswer: "" }));
  assert.match(out, /是否回复: 否/);
  assert.match(out, /跳过原因: 模型判定该消息与自己无关/);
});

test("formatModelReplyEntry explains a skip when the reply came back empty", () => {
  const out = formatModelReplyEntry(decision({ finalAnswer: "" }));
  assert.match(out, /是否回复: 是/);
  assert.match(out, /跳过原因: 模型选择回复，但最终回复内容为空。/);
});

test("formatModelReplyEntry includes the admin action only when there is one", () => {
  const withAdmin = formatModelReplyEntry(
    decision({ adminActionStatus: "accepted", adminActionReason: "r" }),
  );
  assert.match(withAdmin, /管理员动作: accepted/);
  assert.match(withAdmin, /动作说明: r/);
  assert.doesNotMatch(formatModelReplyEntry(decision()), /管理员动作/);
});

test("formatModelReplyEntry renders empty fields as （空）", () => {
  assert.match(formatModelReplyEntry(decision({ thinkingProcess: "" })), /思考过程: （空）/);
});
