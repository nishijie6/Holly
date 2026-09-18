// 谁能夺走 Holly 的注意力。
//
// 焦点模型下由模型自己决定看什么，这带来一个「每批消息都触发一次判断」的老设计不可能有的
// 故障：有人正经找她，她却因为从没打开那个群而一直没回。对群里的闲聊无所谓，对着她说话的
// 人则不可接受，所以有一类消息绕开模型的自由裁量、直接夺焦——kagami 的「前台实时路径」对
// 它的通知横幅，只是那条线在哪里划由这里决定，而不是由模型决定。
//
// 线划在「结构上被叫到」，不是「被谈论到」。一条只是提到「holly」这个名字的消息仍然是横幅：
// 让关于她的散文夺焦，等于任何群靠聊她就能把注意力从一场真正的对话里拽走。
//
// 私聊和管理员曾经也在这条线内侧，2026-09-19 撤掉了。理由是它们和 @ 不是一回事：@ 是一个
// 结构信号，此刻此地有人点了她的名；私聊和管理员是身份，一整条会话永远成立。按身份夺焦意味着
// 只要那个人开口，不管说的是什么、她手上正在做什么，焦点都会被拉过去——这恰恰是焦点模型想
// 交还给她的那个判断。撤掉之后它们走通知路径：她照样看得见，开不开由她自己定。
//
// 代价是明确的：她可能不回一条私聊、不回管理员。挡这个的不再是这里的规则，而是 focus-loop.md
// 里写给她的判断，以及管理员那条硬性要求——那条要求本来就只有在她打开会话之后才谈得上。

export type IncomingFocusSignal = {
  rawMessage: string | null;
};

export type FocusDecision = {
  foreground: boolean;
  // 为什么，给 monitor 看的。不是给模型的。
  reason: "at-mention" | "ambient";
};

function mentionsBot(rawMessage: string, botUserId: string | null): boolean {
  // 无歧义的那种：客户端为这个账号发出了一个真正的 at 段。
  if (botUserId && new RegExp(`\\[CQ:at,[^\\]]*qq=${botUserId}\\b`, "i").test(rawMessage)) {
    return true;
  }
  // 手打而不是点出来的："@holly" / "@10000002"。必须带 "@"——散文里的裸名字有意不算。
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
  if (signal.rawMessage && mentionsBot(signal.rawMessage, botUserId)) {
    return { foreground: true, reason: "at-mention" };
  }
  return { foreground: false, reason: "ambient" };
}
