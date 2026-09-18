// 自主轮次的触发门控：一次零 LLM 的纯函数判定，决定这一分钟要不要花钱问「现在该做点什么」。
//
// 形状照搬 kagami 的 inner-voice idle-detector：判定本身不调模型，信号取自她自己的行为，
// 三条全中才放行。Holly 这边替换的只有信号来源——kagami 数的是 wait 调用的密度（她反复用
// 行为表态「没什么可干的」），而 Holly 的 focus 管线没有 wait 这个工具，等价物是「多久没人
// 找她、她也没说话」。
//
// 为什么要这道门：autonomy 每分钟醒一次，以前每次都直接调一次判断。那个调用一天九百多次、
// 每次七百来 token，而且短到够不着最小可缓存长度，一个 token 的缓存都吃不上，每次全价重付。
// 绝大多数轮次的答案是 do_nothing——判断提示词自己就写着「大多数 tick 应该如此」——这些钱
// 买回来的是一句「这会儿不想做事」。
//
// 更要紧的是第二条。以前她正在群里跟人聊天时，这个循环照样每分钟问一次「要不要去做点自己的
// 事」。她有事做的时候不该被这样打断，哪怕她每次都答不做。
//
// 判定为真只意味着「可以问了」，不代表她会做什么——选哪个动作、要不要做，仍然是她的判断。
// 这道门管的是什么时候开口问，不是问出什么答案。

const BEIJING_TIME_ZONE = "Asia/Shanghai";

export type AutonomyIdlePolicy = {
  /** 距上次真正问过的不应期。 */
  judgmentCooldownMs: number;
  /** 她安静多久才算闲下来——群里没人找她、她也没说话。 */
  focusIdleMs: number;
  /** 静默窗起点（北京时间小时，含）。 */
  quietStartHour: number;
  /** 静默窗终点（北京时间小时，不含）。 */
  quietEndHour: number;
};

export const AUTONOMY_IDLE_POLICY: AutonomyIdlePolicy = {
  judgmentCooldownMs: 15 * 60 * 1000,
  focusIdleMs: 5 * 60 * 1000,
  // 跟 kagami 一致：凌晨一点到早上九点不起这个念头。她也有作息。
  quietStartHour: 1,
  quietEndHour: 9,
};

export type AutonomyIdleSignals = {
  /** 上次真正发出判断调用的时刻；0 表示还没问过。 */
  lastJudgmentAt: number;
  /** 上次群里有动静的时刻；0 表示本次启动以来一直没有。 */
  lastFocusActivityAt: number;
};

/** 北京时间的小时数（0–23）。 */
export function getBeijingHour(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BEIJING_TIME_ZONE,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hourPart = parts.find((part) => part.type === "hour")?.value ?? "0";
  // Intl 的 hour12:false 在部分环境把 0 点格式化成 "24"，归一到 0。
  return Number.parseInt(hourPart, 10) % 24;
}

export type AutonomyIdleVerdict =
  | { ask: true }
  | { ask: false; reason: string; nextEligibleAt: number | null };

/** 纯函数判定：此刻要不要发出一次判断调用。 */
export function evaluateAutonomyTrigger(input: {
  now: number;
  signals: AutonomyIdleSignals;
  policy?: AutonomyIdlePolicy;
}): AutonomyIdleVerdict {
  const policy = input.policy ?? AUTONOMY_IDLE_POLICY;
  const { now, signals } = input;

  const hour = getBeijingHour(new Date(now));
  if (hour >= policy.quietStartHour && hour < policy.quietEndHour) {
    // 静默窗按小时算，给不出精确的解禁时刻；报 null 而不是编一个。
    return { ask: false, reason: "夜里不起这个念头", nextEligibleAt: null };
  }

  // 0 表示本次启动以来群里一直没动静，那就是闲着——重启后先当她闲，宁可早一步问，
  // 也不要因为不知道而把她按在原地。
  if (signals.lastFocusActivityAt > 0) {
    const idleUntil = signals.lastFocusActivityAt + policy.focusIdleMs;
    if (idleUntil > now) {
      return { ask: false, reason: "她这会儿正忙着", nextEligibleAt: idleUntil };
    }
  }

  if (signals.lastJudgmentAt > 0) {
    const readyAt = signals.lastJudgmentAt + policy.judgmentCooldownMs;
    if (readyAt > now) {
      return { ask: false, reason: "刚问过，还在不应期里", nextEligibleAt: readyAt };
    }
  }

  return { ask: true };
}
