// Proactive Holly — slice 1: revive a dropped interest thread during a lull.
//
// 触发流程(每个 tick,串行挂在 modelQueue 上,不抢反应式、共享缓存前缀 6A):
//
//   rollDaily → 遍历有历史的群:
//     ① 结算上一次观察窗(2A:成功→退避清零;被无视→backoff++)
//     ② 规则闸(echo-only / 最后一条是Holly / lull边界 / pending / 日上限 / 全局上限 / 冷却 / backoff)
//     ③ 找"被冷掉的兴趣话题"(关键词宽松粗筛 4A;门控B模型才是权威)
//     ④ 已接过(TTL内)→ 跳过
//     ⑤ 门控B:模型判 should_reply + 写话(复用决策机制)
//     ⑥ 输出校验(单行/禁@/长度)
//     ⑦ shadow:记日志不发 | live(白名单群):发送前复查 1A → 发送
//
// 切片1 默认 shadow:算 + 记日志 + 绝不发,跑几天自动攒 ground-truth。

import type { HollyStateStore } from "./holly-state.js";

export type ProactiveLogKind = "status" | "outgoing" | "assistant" | "error";

export type ProactiveDecision = {
  shouldReply: boolean;
  finalAnswer: string;
  thinkingProcess: string;
};

// Gate-B request. The timeline itself carries no extra marking or re-quoted
// excerpt: the model reads the group's tail straight from the global timeline,
// and this only tells it where the current proactive trigger cycle starts.
export type ProactiveRevivalRequest = {
  groupKey: string;
  // Start of the current proactive trigger cycle (the interest window the rule
  // gate scanned before the lull), ms epoch.
  cycleStartMs: number;
  // Optional browser observation, passed as reference material — never spliced
  // into the timeline.
  observationSummary: string | null;
};

export type ProactiveWorldObservationRequest = {
  groupKey: string;
  threadKey: string;
  matchedKeyword: string;
  threadSummary: string;
  history: ProactiveTurn[];
};

export type ProactiveWorldObservation = {
  query: string;
  summary: string;
  urls: string[];
  pageErrors?: string[];
  cached?: boolean;
};

export type ProactiveGroupAction = {
  type: "send_group_message";
  mode: "shadow" | "live";
  groupKey: string;
  groupId: number | null;
  threadKey: string;
  matchedKeyword: string;
  text: string;
};

export type ProactiveTickResult = {
  actions: ProactiveGroupAction[];
};

// Structural shape compatible with main.ts ConversationTurn (extra fields ok).
export type ProactiveTurn = {
  role: "user" | "assistant";
  content: string;
  timestamp: string; // ISO
  senderName: string | null;
  userId: string | null;
};

export type ProactiveConfig = {
  enabled: boolean;
  mode: "shadow" | "live";
  liveGroupAllowlist: string[];
  lullMinMs: number;
  lullDeadzoneMs: number;
  interestWindowMs: number;
  perGroupDailyCap: number;
  globalDailyCap: number;
  cooldownMs: number;
  observationWindowMs: number;
  successWindowMs: number;
  backoffMultiplier: number;
  engagedTtlMs: number;
  maxReplyChars: number;
  interestKeywords: string[];
  echoOnlyGroups: string[];
};

export type ProactiveDeps = {
  now: () => number;
  listGroups: () => string[];
  getHistory: (groupKey: string) => ProactiveTurn[];
  observeWorld?: (request: ProactiveWorldObservationRequest) => Promise<ProactiveWorldObservation | null>;
  evaluateRevival: (request: ProactiveRevivalRequest) => Promise<ProactiveDecision | null>;
  // Returns the upstream id of the sent message when known (null otherwise), so
  // the recorded assistant turn can dedupe against the same message if it later
  // re-enters context via the day-history bootstrap.
  send: (groupId: number, text: string) => Promise<string | null>;
  appendAssistantTurn: (groupKey: string, text: string, messageId?: string | null) => void;
  parseGroupId: (groupKey: string) => number | null;
  log: (kind: ProactiveLogKind, title: string, body: string) => void;
  shadowLog: (record: Record<string, unknown>) => void;
  config: ProactiveConfig;
  state: HollyStateStore;
};

function parseTs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : NaN;
}

function matchInterest(text: string, keywords: string[]): string | null {
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    const k = kw.trim();
    if (k && lower.includes(k.toLowerCase())) return k;
  }
  return null;
}

// Output post-validation (codex T8): one natural single line, no @ spam.
export function validateProactiveLine(text: string, maxChars: number): { ok: boolean; reason?: string } {
  const t = text.trim();
  if (!t) return { ok: false, reason: "empty" };
  if (/\r|\n/.test(t)) return { ok: false, reason: "multiline" };
  if (/\[CQ:at|@\d{5,}|@everyone|@all/i.test(t)) return { ok: false, reason: "at_spam" };
  if (Array.from(t).length > maxChars) return { ok: false, reason: "too_long" };
  const questionMarks = (t.match(/[?？]/g) ?? []).length;
  if (questionMarks >= 3) return { ok: false, reason: "question_barrage" };
  return { ok: true };
}

function formatCycleStartForModel(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The gate-B decision instruction. It rides in the *current message* slot so the
// cached system + this-group's-history prefix is reused (6A) — only this tail
// differs from a reactive call, so the proactive call hits the prompt cache. The
// timeline is sent whole with no extra marking or re-quoted excerpt: this
// instruction only names the group and the start of the current proactive
// trigger cycle, and the model reads that group's tail straight from the
// timeline above. Kept here (not in main.ts) so the eval harness can exercise
// the exact production prompt.
export function buildProactiveRevivePrompt(request: ProactiveRevivalRequest): string {
  const lines = [
    "现在没有人 @ Holly，下面这个群已经冷场了一会儿：",
    `- group_id: ${request.groupKey}`,
    `- 本次主动触发周期起点: ${formatCycleStartForModel(request.cycleStartMs)}`,
    "- 上方本群时间线的每条消息都以 [月-日 时:分] 标注发送时间。只看发送时间在本次周期起点之后的消息；更早的内容仅作背景，不要当作要捡的话题。",
    "- 如果下方出现「其它群近期动态」，那只是背景参考，不是要捡的话题来源。",
  ];
  if (request.observationSummary) {
    lines.push(
      "Holly 决定开口前浏览了网页，下面的 Browser observation 仅作参考材料，不要再要求搜索：",
      "---",
      request.observationSummary,
      "---",
    );
  }
  lines.push(
    "判断 Holly 现在要不要【主动】把周期内和她兴趣（数学/AI/天文）相关、但冷掉的话题捡回来，自然地说一句。",
    "只有当她确实有具体的东西能补、并且这一句不尬、不像硬找话时，才 should_reply=true。",
    "拿不准、或只是为了说话而说话 → should_reply=false。",
    "返回 JSON，shape：",
    '{"should_reply": true, "final_answer": "一句简短中文", "thinking_process": "简短中文决策摘要", "need_search": false, "search_query": ""}',
    "final_answer 必须是一句简短中文、单行、不 @ 任何人；should_reply=false 时 final_answer 为空字符串。",
    "need_search 固定为 false，search_query 留空字符串（主动开口不走搜索）。",
  );
  return lines.join("\n");
}

export type DroppedThread = {
  threadKey: string;
  summary: string;
  matchedKeyword: string;
  // Start of the scanned interest window = start of this proactive trigger cycle.
  windowStartMs: number;
};

// Find an interest topic that appeared in the recent window just before the
// group went quiet. Loose keyword match (4A) — the model is the real authority.
export function findDroppedInterestThread(
  history: ProactiveTurn[],
  cfg: ProactiveConfig,
): DroppedThread | null {
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  const lastMs = parseTs(last.timestamp);
  if (!Number.isFinite(lastMs)) return null;

  const windowStart = lastMs - cfg.interestWindowMs;
  const windowTurns = history.filter((turn) => {
    const ms = parseTs(turn.timestamp);
    return Number.isFinite(ms) && ms >= windowStart && ms <= lastMs && turn.role === "user";
  });
  if (windowTurns.length === 0) return null;

  let matchedKeyword: string | null = null;
  let matchTurnMs = lastMs;
  for (const turn of windowTurns) {
    const kw = matchInterest(turn.content, cfg.interestKeywords);
    if (kw) {
      matchedKeyword = kw;
      matchTurnMs = parseTs(turn.timestamp);
    }
  }
  if (!matchedKeyword) return null;

  // 30-min bucket so the same dropped topic dedupes, but a later recurrence is new.
  const bucket = Math.floor(matchTurnMs / (30 * 60 * 1000));
  const threadKey = `${matchedKeyword.toLowerCase()}:${bucket}`;

  const summary = windowTurns
    .slice(-6)
    .map((t) => `${t.senderName ?? "某人"}: ${t.content.trim()}`)
    .join("\n");

  return { threadKey, summary, matchedKeyword, windowStartMs: windowStart };
}

function backoffFactor(level: number, multiplier: number): number {
  return Math.pow(multiplier, Math.max(0, level));
}

// True if a user spoke within the success window after `sentAt` (2A refinement
// from codex: not "any message ever after", a tighter engagement window).
function userEngagedAfter(history: ProactiveTurn[], sentAt: number, successWindowMs: number): boolean {
  for (const turn of history) {
    if (turn.role !== "user") continue;
    const ms = parseTs(turn.timestamp);
    if (Number.isFinite(ms) && ms > sentAt && ms - sentAt <= successWindowMs) return true;
  }
  return false;
}

// ②③④ 三道闸合成一个判断：这个群此刻有没有一个「该捡起来的话题」。
//
// 抽出来是为了让 hasProactiveWork 能在不调模型、不产生任何副作用的前提下问同一个问题。
// 两处各写一份闸门迟早会漂，而漂的后果很隐蔽：预查说没事、真跑起来却有事（漏了一次主动
// 发言），或者反过来每轮都说有事（降频白做）。
//
// 注意这里读 pendingObservation 只当作「这个群正在观察窗里，别叠第二个」。真正需要跑结算
// 的情况由调用方各自处理：runProactiveTick 在 ① 里结算，hasProactiveWork 直接据此返回
// true——结算有副作用，不能放进这个纯判断里。
function findActionableThread(
  deps: ProactiveDeps,
  groupKey: string,
  history: ProactiveTurn[],
  now: number,
): DroppedThread | null {
  const cfg = deps.config;
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  const lastMs = parseTs(last.timestamp);
  if (!Number.isFinite(lastMs)) return null;
  const lull = now - lastMs;
  const g = deps.state.getGroup(groupKey);

  if (cfg.echoOnlyGroups.includes(groupKey)) return null;
  if (last.role === "assistant") return null;
  const factor = backoffFactor(g.backoffLevel, cfg.backoffMultiplier);
  if (lull < cfg.lullMinMs * factor) return null;
  if (lull > cfg.lullDeadzoneMs) return null;
  if (g.pendingObservation) return null; // 一次只追一个观察窗
  if (g.dailyCount >= cfg.perGroupDailyCap) return null;
  if (deps.state.globalDailyCount() >= cfg.globalDailyCap) return null;
  if (g.lastProactiveAt > 0 && now - g.lastProactiveAt < cfg.cooldownMs * factor) return null;

  const thread = findDroppedInterestThread(history, cfg);
  if (!thread) return null;
  if (deps.state.isThreadEngaged(groupKey, thread.threadKey, now)) return null;
  return thread;
}

// 这一轮 autonomy tick 里，主动发言这条线有没有事可做。
//
// 存在的理由是省钱：autonomy 每分钟醒一次，每次都无条件问一遍判断模型「现在该干什么」，
// 一天九百多次、每次七百来 token，而且这些请求短到够不着最小可缓存长度，一个 token 的
// 缓存都吃不上。真相是绝大多数轮次三个定时候选都没到期、主动发言也在冷却里——那一轮
// 无论模型怎么答都只能是 do_nothing，这次调用纯属白花。
//
// 返回 true 的两种情形，缺一不可：
//   - 有群还挂着待结算的观察窗。结算必须发生，否则 backoffLevel 永远不更新，而
//     findActionableThread 又因为 pendingObservation 还在而一直说没事做——两边一卡就是
//     死锁，那个群再也不会被主动发言碰到。
//   - 有群真的通过了全部规则闸。
export function hasProactiveWork(deps: ProactiveDeps): boolean {
  if (!deps.config.enabled) return false;
  const now = deps.now();
  for (const groupKey of deps.listGroups()) {
    if (deps.state.getGroup(groupKey).pendingObservation) return true;
    if (findActionableThread(deps, groupKey, deps.getHistory(groupKey), now)) return true;
  }
  return false;
}

export async function runProactiveTick(deps: ProactiveDeps): Promise<ProactiveTickResult> {
  const cfg = deps.config;
  const actions: ProactiveGroupAction[] = [];
  if (!cfg.enabled) return { actions };

  const now = deps.now();
  deps.state.rollDaily(now);
  deps.state.setEngagedTtl(cfg.engagedTtlMs);

  let mutated = false;

  for (const groupKey of deps.listGroups()) {
    const history = deps.getHistory(groupKey);
    if (history.length === 0) continue;
    const last = history[history.length - 1];
    const lastMs = parseTs(last.timestamp);
    if (!Number.isFinite(lastMs)) continue;
    const lull = now - lastMs;

    // ① 结算上一次观察窗(无论当前冷不冷场)
    const g = deps.state.getGroup(groupKey);
    if (g.pendingObservation) {
      const engaged = userEngagedAfter(history, g.pendingObservation.sentAt, cfg.successWindowMs);
      const outcome = deps.state.settleObservation(groupKey, {
        now,
        observationWindowMs: cfg.observationWindowMs,
        backoffMultiplier: cfg.backoffMultiplier,
        engaged,
      });
      if (outcome) {
        mutated = true;
        deps.log("status", `Proactive 观察窗结算: ${outcome}`,
          `group=${groupKey} backoffLevel=${deps.state.getGroup(groupKey).backoffLevel}`);
      }
    }

    // ②③④ 规则闸 + 找话题 + 已接过。全部确定性，不碰模型，所以 hasProactiveWork
    // 能拿同一个函数提前问一遍「这一轮到底有没有事可做」。
    const thread = findActionableThread(deps, groupKey, history, now);
    if (!thread) continue;
    // 发送前复查还要用退避系数。闸门本身已经在 findActionableThread 里查过了，这里重算
    // 一次是因为 ① 的结算可能刚刚动过 backoffLevel。
    const factor = backoffFactor(deps.state.getGroup(groupKey).backoffLevel, cfg.backoffMultiplier);

    // ⑤ 门控B:模型判要不要捡 + 写话。时间线不再做摘录/额外标记 —— 指令只报
    //    group_id + 本次触发周期起点,模型直接读全局时间线末尾。
    let worldObservation: ProactiveWorldObservation | null = null;
    if (deps.observeWorld) {
      try {
        worldObservation = await deps.observeWorld({
          groupKey,
          threadKey: thread.threadKey,
          matchedKeyword: thread.matchedKeyword,
          threadSummary: thread.summary,
          history,
        });
      } catch (error) {
        deps.log("error", "Proactive browser observation failed", error instanceof Error ? error.message : String(error));
      }
      if (worldObservation?.summary) {
        const sources = worldObservation.urls.length > 0
          ? worldObservation.urls.map((url, index) => `${index + 1}. ${url}`).join("\n")
          : "(none)";
        deps.log(
          "status",
          worldObservation.cached ? "Proactive browser observation cached" : "Proactive browser observation",
          `group=${groupKey} keyword=${thread.matchedKeyword}\nquery=${worldObservation.query}\n${sources}`,
        );
      }
    }

    let decision: ProactiveDecision | null;
    try {
      decision = await deps.evaluateRevival({
        groupKey,
        cycleStartMs: thread.windowStartMs,
        observationSummary: worldObservation?.summary ?? null,
      });
    } catch (error) {
      deps.log("error", "Proactive 门控B失败", error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!decision) continue;
    if (!decision.shouldReply || !decision.finalAnswer) {
      deps.log("status", "Proactive 跳过(模型判否)",
        `group=${groupKey} keyword=${thread.matchedKeyword}\n${decision.thinkingProcess || "（空）"}`);
      continue;
    }

    // ⑥ 输出校验
    const valid = validateProactiveLine(decision.finalAnswer, cfg.maxReplyChars);
    if (!valid.ok) {
      deps.log("status", "Proactive 跳过(输出不合格)",
        `group=${groupKey} reason=${valid.reason}\n${decision.finalAnswer}`);
      continue;
    }

    const isLiveForGroup = cfg.mode === "live" && cfg.liveGroupAllowlist.includes(groupKey);

    if (!isLiveForGroup) {
      // SHADOW:记日志,绝不发。仍走完整限流(让日志反映真实节奏)。
      deps.state.recordProactive(groupKey, thread.threadKey, now);
      mutated = true;
      deps.log("status", "Proactive [SHADOW] 本应开口",
        `group=${groupKey} keyword=${thread.matchedKeyword}\n拟发: ${decision.finalAnswer}`);
      deps.shadowLog({
        ts: new Date(now).toISOString(),
        group: groupKey,
        keyword: thread.matchedKeyword,
        threadKey: thread.threadKey,
        lullMs: lull,
        worldObservation: worldObservation
          ? {
              query: worldObservation.query,
              urls: worldObservation.urls,
              cached: worldObservation.cached === true,
            }
          : null,
        wouldSend: decision.finalAnswer,
        thinking: decision.thinkingProcess,
        state: deps.state.snapshotForLog(groupKey),
      });
      actions.push({
        type: "send_group_message",
        mode: "shadow",
        groupKey,
        groupId: deps.parseGroupId(groupKey),
        threadKey: thread.threadKey,
        matchedKeyword: thread.matchedKeyword,
        text: decision.finalAnswer,
      });
      continue;
    }

    // LIVE:发送前复查(1A)——eval 之后世界可能变了。
    const fresh = deps.getHistory(groupKey);
    const freshLast = fresh[fresh.length - 1];
    const freshLastMs = freshLast ? parseTs(freshLast.timestamp) : NaN;
    const stale =
      !freshLast ||
      freshLast.role === "assistant" ||
      freshLast.timestamp !== last.timestamp || // 来了新消息
      !Number.isFinite(freshLastMs) ||
      now - freshLastMs < cfg.lullMinMs * factor;
    if (stale) {
      deps.log("status", "Proactive 放弃(发送前复查未过)", `group=${groupKey}`);
      continue;
    }

    const groupId = deps.parseGroupId(groupKey);
    if (groupId === null) continue;
    let sentMessageId: string | null;
    try {
      sentMessageId = await deps.send(groupId, decision.finalAnswer);
    } catch (error) {
      deps.log("error", "Proactive 发送失败", error instanceof Error ? error.message : String(error));
      continue;
    }
    deps.appendAssistantTurn(groupKey, decision.finalAnswer, sentMessageId);
    deps.state.recordProactive(groupKey, thread.threadKey, now);
    mutated = true;
    actions.push({
      type: "send_group_message",
      mode: "live",
      groupKey,
      groupId,
      threadKey: thread.threadKey,
      matchedKeyword: thread.matchedKeyword,
      text: decision.finalAnswer,
    });
    deps.log("outgoing", "Proactive 主动发言(live)",
      `group=${groupId} keyword=${thread.matchedKeyword}\n${decision.finalAnswer}`);
  }

  if (mutated) {
    await deps.state.save();
  }
  return { actions };
}
