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
  evaluateRevival: (groupKey: string, threadSummary: string) => Promise<ProactiveDecision | null>;
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

// The gate-B decision instruction. It rides in the *current message* slot so the
// cached system + global-history prefix is reused (6A) — only this tail differs
// from a reactive call, so the proactive call hits the prompt cache. Kept here
// (not in main.ts) so the eval harness can exercise the exact production prompt.
export function buildProactiveRevivePrompt(threadSummary: string): string {
  return [
    "现在没有人 @ Holly，群里已经冷场了一会儿。",
    "冷场前，群里聊过下面这个可能和 Holly 兴趣（数学/AI/天文）相关、但没继续下去的话题：",
    "---",
    threadSummary,
    "---",
    "判断 Holly 现在要不要【主动】把这个话题捡回来，自然地说一句。",
    "只有当她确实有具体的东西能补、并且这一句不尬、不像硬找话时，才 should_reply=true。",
    "拿不准、或只是为了说话而说话 → should_reply=false。",
    "返回 JSON，shape：",
    '{"should_reply": true, "final_answer": "一句简短中文", "thinking_process": "简短中文决策摘要", "need_search": false, "search_query": ""}',
    "final_answer 必须是一句简短中文、单行、不 @ 任何人；should_reply=false 时 final_answer 为空字符串。",
    "need_search 固定为 false，search_query 留空字符串（主动开口不走搜索）。",
    "If a Browser observation block is included above, use it only as reference material; do not ask to search again.",
  ].join("\n");
}

export type DroppedThread = { threadKey: string; summary: string; matchedKeyword: string };

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

  return { threadKey, summary, matchedKeyword };
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

    // ② 规则闸
    if (cfg.echoOnlyGroups.includes(groupKey)) continue;
    if (last.role === "assistant") continue;
    const factor = backoffFactor(g.backoffLevel, cfg.backoffMultiplier);
    if (lull < cfg.lullMinMs * factor) continue;
    if (lull > cfg.lullDeadzoneMs) continue;
    if (g.pendingObservation) continue; // 一次只追一个观察窗
    if (g.dailyCount >= cfg.perGroupDailyCap) continue;
    if (deps.state.globalDailyCount() >= cfg.globalDailyCap) continue;
    if (g.lastProactiveAt > 0 && now - g.lastProactiveAt < cfg.cooldownMs * factor) continue;

    // ③ 找被冷掉的兴趣话题
    const thread = findDroppedInterestThread(history, cfg);
    if (!thread) continue;
    // ④ 已接过(TTL 内)
    if (deps.state.isThreadEngaged(groupKey, thread.threadKey, now)) continue;

    // ⑤ 门控B:模型判要不要捡 + 写话
    let threadSummary = thread.summary;
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
        threadSummary = [
          thread.summary,
          "",
          "Holly browsed the web for this dropped topic before deciding whether to revive it:",
          worldObservation.summary,
        ].join("\n");
      }
    }

    let decision: ProactiveDecision | null;
    try {
      decision = await deps.evaluateRevival(groupKey, threadSummary);
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
