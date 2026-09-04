// Who gets to take Holly's attention.
//
// Under the focus model the model decides what to look at, which introduces a
// failure the old "every batch triggers a decision" design could not have: a
// group can be left unanswered simply because Holly never opened it. That is
// fine for ambient chatter and unacceptable for someone addressing Holly
// directly, so a narrow class of messages bypasses the model's discretion and
// seizes focus — kagami's "foreground real-time path" versus its notification
// banners, with the split decided here instead of by the model.
//
// The line is drawn at *structurally* being addressed, not at being talked
// about. A message that merely says the name "holly" stays a banner: letting
// prose about Holly seize focus would let any group pull attention away from a
// real conversation by gossiping.

export type IncomingFocusSignal = {
  rawMessage: string | null;
  replyTargetType: "group" | "private" | null | undefined;
  // Already resolved by the caller through admin-policy's shouldForceAdminReply,
  // so the allowlist stays the single source of truth for who is an admin.
  adminForcedReply: boolean;
};

export type FocusDecision = {
  foreground: boolean;
  // Why, for the monitor. Not for the model.
  reason: "private-chat" | "at-mention" | "admin-forced" | "ambient";
};

function mentionsBot(rawMessage: string, botUserId: string | null): boolean {
  // The unambiguous form: the client emitted a real at-segment for this account.
  if (botUserId && new RegExp(`\\[CQ:at,[^\\]]*qq=${botUserId}\\b`, "i").test(rawMessage)) {
    return true;
  }
  // Typed rather than clicked: "@holly" / "@10000002". Requires the "@" — a
  // bare name in prose is deliberately not enough.
  const typed = rawMessage.matchAll(/@([^\s,@，。:：]+)/gu);
  for (const match of typed) {
    const target = match[1]?.trim().toLowerCase();
    if (!target) continue;
    if (target === "holly" || (botUserId !== null && target === botUserId)) {
      return true;
    }
  }
  return false;
}

export function decideFocus(signal: IncomingFocusSignal, botUserId: string | null): FocusDecision {
  // A private message has no "someone else's conversation" reading: it was sent
  // to Holly and nobody else.
  if (signal.replyTargetType === "private") {
    return { foreground: true, reason: "private-chat" };
  }
  if (signal.adminForcedReply) {
    return { foreground: true, reason: "admin-forced" };
  }
  if (signal.rawMessage && mentionsBot(signal.rawMessage, botUserId)) {
    return { foreground: true, reason: "at-mention" };
  }
  return { foreground: false, reason: "ambient" };
}
