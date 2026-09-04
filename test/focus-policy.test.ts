import assert from "node:assert/strict";
import test from "node:test";

import { decideFocus } from "../focus-policy.js";

// The fallback that keeps the focus model from silently ignoring people. The
// risk being guarded is asymmetric: wrongly staying a banner means someone
// addressing Holly gets no answer, while wrongly seizing focus means Holly gets
// yanked out of a real conversation by chatter. Both are pinned here.

const BOT = "10000002";
const group = (rawMessage: string | null, adminForcedReply = false) =>
  decideFocus({ rawMessage, replyTargetType: "group" as const, adminForcedReply }, BOT);

test("a private message is always foreground", () => {
  const decision = decideFocus(
    { rawMessage: "在吗", replyTargetType: "private", adminForcedReply: false },
    BOT,
  );
  assert.deepEqual(decision, { foreground: true, reason: "private-chat" });
});

test("an admin forced reply is foreground even without an @", () => {
  const decision = decideFocus(
    { rawMessage: "重启一下", replyTargetType: "private", adminForcedReply: true },
    BOT,
  );
  assert.equal(decision.foreground, true);
});

test("admin-forced wins in a group with no mention", () => {
  assert.deepEqual(group("处理一下", true), { foreground: true, reason: "admin-forced" });
});

test("a clicked at-segment for this account seizes focus", () => {
  assert.deepEqual(group(`[CQ:at,qq=${BOT}] 来看看这个`), {
    foreground: true,
    reason: "at-mention",
  });
});

test("an at-segment for somebody else does not", () => {
  assert.equal(group("[CQ:at,qq=10000004] 你怎么看").foreground, false);
});

test("an at-segment whose qq merely starts with the bot's id does not match", () => {
  // \b stops "100000029" from reading as the bot.
  assert.equal(group(`[CQ:at,qq=${BOT}9] hi`).foreground, false);
});

test("a typed @holly seizes focus", () => {
  assert.deepEqual(group("@holly 你怎么看"), { foreground: true, reason: "at-mention" });
});

test("a typed @ with the bot's number seizes focus", () => {
  assert.equal(group(`@${BOT} 在吗`).foreground, true);
});

test("case does not matter for a typed mention", () => {
  assert.equal(group("@Holly 在吗").foreground, true);
});

test("being talked about is not being addressed", () => {
  // The loose reading — any occurrence of the name — would let a group pull
  // Holly out of another conversation just by discussing her.
  assert.deepEqual(group("holly 昨天说的那个事挺有意思"), { foreground: false, reason: "ambient" });
  assert.equal(group("我觉得 Holly 的回复越来越像人了").foreground, false);
});

test("ordinary group chatter stays a banner", () => {
  assert.deepEqual(group("今天好冷"), { foreground: false, reason: "ambient" });
});

test("a null raw message is ambient, not a crash", () => {
  assert.deepEqual(group(null), { foreground: false, reason: "ambient" });
});

test("with no configured bot id, only a typed @holly still works", () => {
  const noBot = (rawMessage: string) =>
    decideFocus({ rawMessage, replyTargetType: "group", adminForcedReply: false }, null);
  assert.equal(noBot("@holly 在吗").foreground, true);
  assert.equal(noBot(`[CQ:at,qq=${BOT}] hi`).foreground, false);
});

test("private chat outranks ambient content", () => {
  assert.equal(
    decideFocus({ rawMessage: "今天好冷", replyTargetType: "private", adminForcedReply: false }, BOT).reason,
    "private-chat",
  );
});
