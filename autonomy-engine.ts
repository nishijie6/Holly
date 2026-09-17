import type {
  ProactiveTickResult,
  ProactiveWorldObservation,
} from "./proactive-engine.js";

export type AutonomyAction =
  | { type: "do_nothing"; reason: string }
  | { type: "observe_world"; topic: string; reason: string; observed: boolean }
  | { type: "send_group_message"; reason: string; actions: ProactiveTickResult["actions"] }
  | { type: "write_memory"; topic: string; reason: string; content: string }
  | { type: "write_archive"; kind: ArchiveWorkKind; title: string; reason: string };

export type AutonomyCheckName =
  | "world_observation"
  | "memory_reflection"
  | "archive_writing"
  | "group_proactive";

export type AutonomyCheckStatus =
  | "disabled"
  | "waiting"
  | "acted"
  | "no_action"
  | "deferred";

// A concise, operator-facing trace of what the once-per-minute scheduler
// checked. This is policy/runtime state, not a model provider's hidden chain of
// thought. `nextEligibleAt` lets the monitor explain why an interval gate held.
export type AutonomyCheck = {
  name: AutonomyCheckName;
  status: AutonomyCheckStatus;
  reason: string;
  nextEligibleAt: number | null;
};

export type ArchiveWorkKind = "article" | "poem";

export type AutonomyConfig = {
  enabled: boolean;
  worldObservationEnabled: boolean;
  // 世界观察没有固定间隔：只要开着、配了话题，每轮都可以去，去不去、看哪个由每轮的判断定。这个值只管
  // 抓取失败之后多久才能再试——失败通常说明这会儿就是抓不动，立刻重试只会接着失败。
  worldObservationRetryMs: number;
  worldObservationBroadcastGroupId: string | null;
  // Failed observations (empty fetch, page errors, unusable content) get a
  // short notice here instead of being silently skipped.
  worldObservationFailureGroupId: string | null;
  // Successful observations only go to the broadcast group when it has been
  // quiet for at least this long (don't interrupt an active conversation).
  worldObservationBroadcastLullMs: number;
  // Suppress recently broadcast URLs and semantically equivalent headlines.
  // 历史取自所有播报目标群的持久化时间线之和，而不只是这次要发的那个群——见
  // worldObservationBroadcastGroupIds。
  worldObservationDedupWindowMs: number;
  worldTopics: string[];
  // Per-topic override for browser_agent.query_suffix, keyed by exact topic
  // string. Some topics don't compose with a generic "latest progress" style
  // suffix (e.g. "数学趣题" + "最新 进展" produces a query nothing real
  // matches, a genuine empty-page failure rather than the LLM-extraction
  // false-positive covered by the world-observation broadcast fallback).
  // Missing entry = use browser_agent.query_suffix as before; "" = no suffix.
  worldTopicQuerySuffixOverrides: Record<string, string>;
  // 按话题覆盖播报目标群，键是 worldTopics 里的话题原文。没列出的话题发往
  // worldObservationBroadcastGroupId。
  worldTopicBroadcastGroupOverrides: Record<string, string>;
  // 按话题的固定来源网址，每轮和搜索结果一起读，不看搜索排名。键是 worldTopics 里的话题原文。
  worldTopicSourceUrls: Record<string, string[]>;
  // 按话题写给播报改写那一步的内容范围，比如「数学」要研究新闻和理论突破、不要趣味题。话题名
  // 本身太宽，只凭它模型分不清什么算相关。没写的话题不加说明。
  worldTopicBriefs: Record<string, string>;
  memoryReflectionEnabled: boolean;
  memoryReflectionIntervalMs: number;
  memoryReflectionRetryMs: number;
  memoryReflectionBroadcastGroupId: string | null;
  memoryReflectionBroadcastLullMs: number;
  archiveWritingEnabled: boolean;
  archiveWritingIntervalMs: number;
  archiveWritingRetryMs: number;
};

// ---------- 世界观察播报的目标群 ----------

type BroadcastRoutingConfig = Pick<
  AutonomyConfig,
  "worldObservationBroadcastGroupId" | "worldTopicBroadcastGroupOverrides"
>;

// 话题单独指定了群就发那里，否则发默认群。键按话题原文逐字匹配，写法必须和 worldTopics 一致。
export function resolveWorldObservationBroadcastGroupId(
  config: BroadcastRoutingConfig,
  topic: string,
): string | null {
  return config.worldTopicBroadcastGroupOverrides[topic] ?? config.worldObservationBroadcastGroupId;
}

// 所有可能收到世界观察播报的群。去重时要把它们的历史合在一起看。
//
// 去重原本只翻目标群自己的历史，于是一换目标群、或者按话题分群，新群对别的群七天内发过的
// 内容就一无所知，同一篇文章会再发一遍——2026-09-10 改群当天就发生了。这里把播报当成
// 一条统一的内容流：发过就是发过，不管当时发在哪个群。只算当前配置里的群；从配置里移除的群，
// 它的历史也就不再参与去重。
export function worldObservationBroadcastGroupIds(config: BroadcastRoutingConfig): string[] {
  const ids = [
    config.worldObservationBroadcastGroupId,
    ...Object.values(config.worldTopicBroadcastGroupOverrides),
  ];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

export type AutonomyLoopState = {
  lastWorldObservationAt: number;
  lastWorldObservationAttemptAt: number;
  worldObservationDailyDate: string;
  worldObservationDailyCount: number;
  nextWorldTopicIndex: number;
  lastMemoryReflectionAt: number;
  lastMemoryReflectionAttemptAt: number;
  memoryReflectionDailyDate: string;
  memoryReflectionDailyCount: number;
  lastArchiveWritingAt: number;
  lastArchiveWritingAttemptAt: number;
  archiveWritingDailyDate: string;
  archiveWritingDailyCount: number;
};

export type AutonomyWorldObservationRequest = {
  topic: string;
  reason: string;
};

export type AutonomyMemoryWriteRequest = {
  topic: string;
  reason: string;
  content: string;
  observation?: ProactiveWorldObservation | null;
};

export type AutonomyMemoryReflectionRequest = {
  reason: string;
  nowIso: string;
};

export type AutonomyArchiveComposeRequest = {
  reason: string;
  nowIso: string;
};

export type AutonomyArchiveWriteRequest = {
  kind: ArchiveWorkKind;
  title: string;
  content: string;
  reason: string;
};

export type AutonomyJudgmentCandidate = {
  eligible: boolean;
  note: string;
};

// 每个世界观察话题的近况，交给每轮判断去决定去不去、看哪个。只放事实，不替模型下结论。
export type WorldTopicStatus = {
  topic: string;
  // 这个话题最近一次观察或尝试的时间；0 表示手上没有记录（观察记忆只留 24 小时，失败的尝试重启就忘）。
  lastAt: number;
  // 那一次的结局，一句中文，比如「发到了群里」「页面上没有最近 24 小时的新内容」；空串表示不清楚。
  outcome: string;
};

export type AutonomyJudgmentRequest = {
  nowIso: string;
  worldObservation: AutonomyJudgmentCandidate;
  // 只在世界观察可选时才有内容：不可选时模型本来就不能选它，列出来只是白花 token。
  worldTopics: WorldTopicStatus[];
  memoryReflection: AutonomyJudgmentCandidate;
  archiveWriting: AutonomyJudgmentCandidate;
  groupProactiveNote: string;
  pendingReplyGroupCount: number;
  lastActionSummary: string;
};

export type AutonomyJudgmentDecision =
  | { action: "do_nothing"; reason: string }
  // topic 是模型挑的话题。没给、或给了配置里没有的，引擎退回轮转。
  | { action: "world_observation"; reason: string; topic?: string }
  | { action: "memory_reflection"; reason: string }
  | { action: "archive_writing"; reason: string }
  | { action: "group_proactive"; reason: string };

export type AutonomyDeps = {
  now: () => number;
  config: AutonomyConfig;
  getState: () => AutonomyLoopState;
  saveState: () => Promise<void>;
  observeWorld: (request: AutonomyWorldObservationRequest) => Promise<ProactiveWorldObservation | null>;
  reflectMemory: (request: AutonomyMemoryReflectionRequest) => Promise<AutonomyMemoryWriteRequest | null>;
  writeMemory: (request: AutonomyMemoryWriteRequest) => Promise<void>;
  composeArchive: (request: AutonomyArchiveComposeRequest) => Promise<AutonomyArchiveWriteRequest | null>;
  writeArchive: (request: AutonomyArchiveWriteRequest) => Promise<void>;
  runGroupProactiveAction: () => Promise<ProactiveTickResult>;
  requestJudgment: (request: AutonomyJudgmentRequest) => Promise<AutonomyJudgmentDecision>;
  // 各话题的近况，只在世界观察可选的那一轮取。确定性、无副作用。
  worldTopicStatuses: () => WorldTopicStatus[];
  // 主动发言这条线此刻有没有事可做。确定性、无副作用，用来在三个定时候选都没到期时
  // 省掉那次判断调用——见下面 runAutonomyLoop 里的短路。
  hasProactiveWork: () => boolean;
  pendingReplyGroupCount: () => number;
  log: (kind: "status" | "error", title: string, body: string) => void;
  recordWorldObservation: (record: Record<string, unknown>) => void;
};

export type AutonomyLoopResult = {
  action: AutonomyAction;
  checks: AutonomyCheck[];
};

function localDateKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function rollAutonomyDaily(state: AutonomyLoopState, now: number): void {
  const today = localDateKey(new Date(now));
  if (state.worldObservationDailyDate !== today) {
    state.worldObservationDailyDate = today;
    state.worldObservationDailyCount = 0;
  }
  if (state.memoryReflectionDailyDate !== today) {
    state.memoryReflectionDailyDate = today;
    state.memoryReflectionDailyCount = 0;
  }
  if (state.archiveWritingDailyDate !== today) {
    state.archiveWritingDailyDate = today;
    state.archiveWritingDailyCount = 0;
  }
}

function pickWorldTopic(state: AutonomyLoopState, topics: readonly string[]): string | null {
  if (topics.length === 0) return null;
  const index = Math.abs(Math.floor(state.nextWorldTopicIndex)) % topics.length;
  state.nextWorldTopicIndex = (index + 1) % topics.length;
  return topics[index];
}

// 最近一次尝试没拿到观察、还在重试间隔里时，返回可以再试的时间；否则 null。尝试时间比成功时间新，
// 就说明最近那次失败了——成功的那次，两个时间是同一刻。
function worldObservationRetryAt(cfg: AutonomyConfig, state: AutonomyLoopState, now: number): number | null {
  const attemptAt = state.lastWorldObservationAttemptAt;
  if (attemptAt <= 0 || attemptAt <= state.lastWorldObservationAt) return null;
  const retryAt = attemptAt + cfg.worldObservationRetryMs;
  return retryAt > now ? retryAt : null;
}

// 以前这里还有一道「距上次成功满 60 分钟」的闸，2026-09-15 取消：什么时候想去看看由 Holly 自己判断，
// 不按钟点排班。刚看完紧接着再去也放行——挡住无谓重复的是判断时看到的话题近况，不是时钟。
// 重试间隔只在失败后生效：成功之后不用等，失败之后才要缓一缓。
function worldObservationDue(cfg: AutonomyConfig, state: AutonomyLoopState, now: number): boolean {
  if (!cfg.worldObservationEnabled) return false;
  if (cfg.worldTopics.length === 0) return false;
  return worldObservationRetryAt(cfg, state, now) === null;
}

// 世界观察没有配置间隔，不套 scheduledCheckWhenNotDue：没到期只可能是关着、没配话题，或者失败后在等重试。
function worldObservationCheckWhenNotDue(cfg: AutonomyConfig, state: AutonomyLoopState, now: number): AutonomyCheck {
  if (!cfg.worldObservationEnabled || cfg.worldTopics.length === 0) {
    return {
      name: "world_observation",
      status: "disabled",
      reason: cfg.worldObservationEnabled ? "没有配置世界观察主题" : "世界观察已关闭",
      nextEligibleAt: null,
    };
  }
  return {
    name: "world_observation",
    status: "waiting",
    reason: "上次观察没拿到可用内容，还在重试间隔里",
    nextEligibleAt: worldObservationRetryAt(cfg, state, now),
  };
}

function memoryReflectionDue(cfg: AutonomyConfig, state: AutonomyLoopState, now: number): boolean {
  if (!cfg.memoryReflectionEnabled) return false;
  if (state.lastMemoryReflectionAt > 0 && now - state.lastMemoryReflectionAt < cfg.memoryReflectionIntervalMs) {
    return false;
  }
  if (
    state.lastMemoryReflectionAttemptAt > 0 &&
    now - state.lastMemoryReflectionAttemptAt < cfg.memoryReflectionRetryMs
  ) {
    return false;
  }
  return true;
}

function archiveWritingDue(cfg: AutonomyConfig, state: AutonomyLoopState, now: number): boolean {
  if (!cfg.archiveWritingEnabled) return false;
  if (state.lastArchiveWritingAt > 0 && now - state.lastArchiveWritingAt < cfg.archiveWritingIntervalMs) {
    return false;
  }
  if (
    state.lastArchiveWritingAttemptAt > 0 &&
    now - state.lastArchiveWritingAttemptAt < cfg.archiveWritingRetryMs
  ) {
    return false;
  }
  return true;
}

function scheduledCheckWhenNotDue(input: {
  name: AutonomyCheckName;
  enabled: boolean;
  disabledReason: string;
  lastCompletedAt: number;
  intervalMs: number;
  lastAttemptAt: number;
  retryMs: number;
  now: number;
}): AutonomyCheck {
  if (!input.enabled) {
    return {
      name: input.name,
      status: "disabled",
      reason: input.disabledReason,
      nextEligibleAt: null,
    };
  }

  const intervalReadyAt = input.lastCompletedAt > 0
    ? input.lastCompletedAt + input.intervalMs
    : 0;
  const retryReadyAt = input.lastAttemptAt > 0
    ? input.lastAttemptAt + input.retryMs
    : 0;
  const nextEligibleAt = Math.max(intervalReadyAt, retryReadyAt);
  const reason = retryReadyAt > intervalReadyAt && retryReadyAt > input.now
    ? "仍在等待上次尝试后的重试间隔"
    : "距离上次完成尚未达到配置间隔";

  return {
    name: input.name,
    status: "waiting",
    reason,
    nextEligibleAt: nextEligibleAt > input.now ? nextEligibleAt : null,
  };
}

function deferredChecks(
  names: AutonomyCheckName[],
  reason: string,
): AutonomyCheck[] {
  return names.map((name) => ({
    name,
    status: "deferred",
    reason,
    nextEligibleAt: null,
  }));
}

function freshnessNote(lastAt: number, now: number): string {
  if (lastAt <= 0) return "从未执行过";
  const minutes = Math.max(0, Math.round((now - lastAt) / 60_000));
  return `距上次已 ${minutes} 分钟`;
}

function lastAutonomyActionSummary(state: AutonomyLoopState, now: number): string {
  const candidates: Array<{ at: number; label: string }> = [
    { at: state.lastWorldObservationAt, label: "world_observation" },
    { at: state.lastMemoryReflectionAt, label: "memory_reflection" },
    { at: state.lastArchiveWritingAt, label: "archive_writing" },
  ].filter((candidate) => candidate.at > 0);
  if (candidates.length === 0) return "尚未行动过";
  const latest = candidates.reduce((a, b) => (b.at > a.at ? b : a));
  const minutes = Math.max(0, Math.round((now - latest.at) / 60_000));
  return `${minutes} 分钟前：${latest.label}`;
}

export async function runAutonomyLoop(deps: AutonomyDeps): Promise<AutonomyLoopResult> {
  const cfg = deps.config;
  if (!cfg.enabled) {
    return {
      action: { type: "do_nothing", reason: "autonomy disabled" },
      checks: deferredChecks(
        ["world_observation", "memory_reflection", "archive_writing", "group_proactive"],
        "自主循环已关闭",
      ).map((check) => ({ ...check, status: "disabled" })),
    };
  }

  const now = deps.now();
  const state = deps.getState();
  rollAutonomyDaily(state, now);

  // Eligibility is computed for all three timed candidates up front, every
  // tick -- unlike the old cascade, a later candidate's Due() is no longer
  // skipped just because an earlier one already "won". Nothing here executes
  // anything yet; these are the ONLY facts the interval/retry gates ever
  // produce, and the judgment call below can only pick from what's eligible.
  const worldEligible = worldObservationDue(cfg, state, now);
  const memoryEligible = memoryReflectionDue(cfg, state, now);
  const archiveEligible = archiveWritingDue(cfg, state, now);

  // Ineligible candidates get their real trace entry now -- nothing changes
  // it between here and the end of the tick, since only the judge's pick
  // (if any) ever runs.
  const worldNotDueCheck = worldEligible ? null : worldObservationCheckWhenNotDue(cfg, state, now);
  const memoryNotDueCheck = memoryEligible ? null : scheduledCheckWhenNotDue({
    name: "memory_reflection",
    enabled: cfg.memoryReflectionEnabled,
    disabledReason: "记忆反思已关闭",
    lastCompletedAt: state.lastMemoryReflectionAt,
    intervalMs: cfg.memoryReflectionIntervalMs,
    lastAttemptAt: state.lastMemoryReflectionAttemptAt,
    retryMs: cfg.memoryReflectionRetryMs,
    now,
  });
  const archiveNotDueCheck = archiveEligible ? null : scheduledCheckWhenNotDue({
    name: "archive_writing",
    enabled: cfg.archiveWritingEnabled,
    disabledReason: "归档写作已关闭",
    lastCompletedAt: state.lastArchiveWritingAt,
    intervalMs: cfg.archiveWritingIntervalMs,
    lastAttemptAt: state.lastArchiveWritingAttemptAt,
    retryMs: cfg.archiveWritingRetryMs,
    now,
  });

  // requestJudgment's own implementation (requestAutonomyJudgment in main.ts)
  // already catches its own LLM/parse failures and resolves to a do_nothing
  // decision -- this second, thinner guard is only for a bug in that contract
  // itself (a dep implementation that throws instead of resolving). Either
  // way, one bad tick degrades to do_nothing instead of propagating up to
  // dispatchAutonomyTickDue's catch as a full tick failure.
  // 什么都做不了的那一轮，不必花钱问模型该做什么。
  //
  // autonomy 每分钟醒一次，判断调用一天九百多次、每次七百来 token，而且短到够不着最小
  // 可缓存长度——一个 token 的缓存都吃不上，那七百 token 每次都按未缓存全价重付。绝大
  // 多数轮次三个定时候选都没到期、主动发言也在冷却里，那一轮无论模型答什么都只能落到
  // do_nothing，这次调用纯属白花。
  //
  // 世界观察取消固定间隔（2026-09-15）之后几乎每轮都可选，这个短路只剩它关着、或者抓取失败在等
  // 重试的时候才省得下来，判断调用基本回到每分钟一次。这是让 Holly 随时能起兴去看看的代价。
  //
  // 短路条件取得保守：只要还有任何一条线可能动，就照常问模型。尤其是主动发言，它的资格
  // 由 proactive 那边的规则闸说了算（包括「有观察窗待结算」这种必须跑一趟的情况），所以
  // 这里问的是 hasProactiveWork 而不是自己另写一套判断。判断权本身没有被拿走：模型仍然
  // 是在「可做的事情」之间选，只是没有可选项时不再走一趟。
  if (!worldEligible && !memoryEligible && !archiveEligible && !deps.hasProactiveWork()) {
    return {
      action: { type: "do_nothing", reason: "无候选到期，跳过判断调用" },
      // 三个定时候选各自报自己真实的「为什么没到期」，主动发言报规则闸没过。都不写成
      // 「模型本轮选择优先做别的」——模型这一轮压根没被问，那样写会让 trace 撒谎。
      checks: [
        worldNotDueCheck!,
        memoryNotDueCheck!,
        archiveNotDueCheck!,
        ...deferredChecks(["group_proactive"], "群聊规则闸未通过（冷场时长/冷却/限流）"),
      ],
    };
  }

  let rawDecision: AutonomyJudgmentDecision;
  try {
    rawDecision = await deps.requestJudgment({
      nowIso: new Date(now).toISOString(),
      worldObservation: {
        eligible: worldEligible,
        note: worldNotDueCheck?.reason ?? freshnessNote(state.lastWorldObservationAt, now),
      },
      worldTopics: worldEligible ? deps.worldTopicStatuses() : [],
      memoryReflection: {
        eligible: memoryEligible,
        note: memoryNotDueCheck?.reason ?? freshnessNote(state.lastMemoryReflectionAt, now),
      },
      archiveWriting: {
        eligible: archiveEligible,
        note: archiveNotDueCheck?.reason ?? freshnessNote(state.lastArchiveWritingAt, now),
      },
      groupProactiveNote: "资格由独立的群聊规则闸判断（冷场/兴趣话题/冷却/限流），这里始终可选",
      pendingReplyGroupCount: deps.pendingReplyGroupCount(),
      lastActionSummary: lastAutonomyActionSummary(state, now),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.log("error", "Autonomy judgment call failed", detail);
    rawDecision = { action: "do_nothing", reason: `判断调用失败：${detail}` };
  }

  // Defensive: the caller is expected to build a JSON schema whose enum only
  // contains currently-eligible candidates (plus do_nothing/group_proactive,
  // which are always offerable), so this should be unreachable. Never trust a
  // model response to bypass an interval gate regardless.
  const decision: AutonomyJudgmentDecision =
    (rawDecision.action === "world_observation" && !worldEligible)
    || (rawDecision.action === "memory_reflection" && !memoryEligible)
    || (rawDecision.action === "archive_writing" && !archiveEligible)
      ? { action: "do_nothing", reason: `判断选中了未到期的项，已忽略：${rawDecision.reason}` }
      : rawDecision;

  const checks: AutonomyCheck[] = [];
  let action: AutonomyAction;
  let executed: AutonomyCheckName | null = null;

  if (decision.action === "world_observation") {
    executed = "world_observation";
    // 看哪个话题由判断自己挑。没挑、或挑了配置里没有的（schema 的枚举本该挡住，换成不认枚举的服务端
    // 就不一定），才退回轮转：配置里没有的话题既没有固定来源也没有播报群，不能去。
    // worldEligible guarantees cfg.worldTopics.length > 0 (see
    // worldObservationDue), so pickWorldTopic never returns null here.
    const chosenTopic = decision.topic && cfg.worldTopics.includes(decision.topic) ? decision.topic : null;
    const topic = chosenTopic ?? pickWorldTopic(state, cfg.worldTopics)!;
    const reason = decision.reason || "world observation";
    state.lastWorldObservationAttemptAt = now;
    state.worldObservationDailyCount += 1;
    let observation: ProactiveWorldObservation | null = null;
    let observationError = "";
    try {
      observation = await deps.observeWorld({ topic, reason });
    } catch (error) {
      observationError = error instanceof Error ? error.message : String(error);
      deps.log("error", "Autonomy observe_world failed", observationError);
    }
    if (observation) {
      state.lastWorldObservationAt = now;
    }
    await deps.saveState();

    if (observation) {
      deps.recordWorldObservation({
        ts: new Date(now).toISOString(),
        action: "observe_world",
        topic,
        ok: true,
        query: observation.query,
        urls: observation.urls,
        page_errors: observation.pageErrors ?? [],
        summary: observation.summary,
      });
    }
    deps.log(
      "status",
      observation ? "Autonomy observe_world" : "Autonomy observe_world empty",
      `topic=${topic}\nquery=${observation?.query ?? ""}\nsources=${observation?.urls.length ?? 0}`,
    );
    checks.push({
      name: "world_observation",
      status: observation ? "acted" : "no_action",
      reason: observation
        ? `已完成“${topic}”世界观察，获得 ${observation.urls.length} 个来源`
        : observationError
          ? `“${topic}”世界观察失败：${observationError}`
          : `已检查“${topic}”，但没有获得可用内容`,
      nextEligibleAt: null,
    });
    action = { type: "observe_world", topic, reason, observed: observation !== null };
  } else if (decision.action === "memory_reflection") {
    executed = "memory_reflection";
    const reason = "scheduled memory reflection";
    state.lastMemoryReflectionAttemptAt = now;
    state.memoryReflectionDailyCount += 1;
    let memory: AutonomyMemoryWriteRequest | null = null;
    let reflectionError = "";
    try {
      memory = await deps.reflectMemory({ reason, nowIso: new Date(now).toISOString() });
    } catch (error) {
      reflectionError = error instanceof Error ? error.message : String(error);
      deps.log("error", "Autonomy memory reflection failed", reflectionError);
    }

    if (memory) {
      try {
        await deps.writeMemory(memory);
        state.lastMemoryReflectionAt = now;
        await deps.saveState();
        deps.log("status", "Autonomy write_memory", `topic=${memory.topic}\nchars=${memory.content.length}`);
        checks.push({
          name: "memory_reflection",
          status: "acted",
          reason: `完成记忆反思并写入“${memory.topic}”`,
          nextEligibleAt: null,
        });
        action = { type: "write_memory", topic: memory.topic, reason: memory.reason, content: memory.content };
      } catch (error) {
        const writeError = error instanceof Error ? error.message : String(error);
        deps.log("error", "Autonomy write_memory failed", writeError);
        const noActionReason = `反思内容未能写入：${writeError}`;
        checks.push({ name: "memory_reflection", status: "no_action", reason: noActionReason, nextEligibleAt: null });
        await deps.saveState();
        action = { type: "do_nothing", reason: noActionReason };
      }
    } else {
      const noActionReason = reflectionError
        ? `记忆反思失败：${reflectionError}`
        : "模型本轮未生成需要写入的记忆";
      checks.push({ name: "memory_reflection", status: "no_action", reason: noActionReason, nextEligibleAt: null });
      await deps.saveState();
      action = { type: "do_nothing", reason: noActionReason };
    }
  } else if (decision.action === "archive_writing") {
    executed = "archive_writing";
    const reason = "scheduled archive writing";
    state.lastArchiveWritingAttemptAt = now;
    state.archiveWritingDailyCount += 1;
    let work: AutonomyArchiveWriteRequest | null = null;
    let compositionError = "";
    try {
      work = await deps.composeArchive({ reason, nowIso: new Date(now).toISOString() });
    } catch (error) {
      compositionError = error instanceof Error ? error.message : String(error);
      deps.log("error", "Autonomy archive composition failed", compositionError);
    }

    if (work) {
      try {
        await deps.writeArchive(work);
        state.lastArchiveWritingAt = now;
        await deps.saveState();
        deps.log("status", "Autonomy write_archive", `kind=${work.kind}\ntitle=${work.title}\nchars=${work.content.length}`);
        checks.push({
          name: "archive_writing",
          status: "acted",
          reason: `完成${work.kind === "poem" ? "诗" : "文章"}“${work.title}”`,
          nextEligibleAt: null,
        });
        action = { type: "write_archive", kind: work.kind, title: work.title, reason: work.reason };
      } catch (error) {
        const archiveWriteError = error instanceof Error ? error.message : String(error);
        deps.log("error", "Autonomy write_archive failed", archiveWriteError);
        const noActionReason = `归档作品未能写入：${archiveWriteError}`;
        checks.push({ name: "archive_writing", status: "no_action", reason: noActionReason, nextEligibleAt: null });
        await deps.saveState();
        action = { type: "do_nothing", reason: noActionReason };
      }
    } else {
      const noActionReason = compositionError
        ? `归档创作失败：${compositionError}`
        : "模型本轮没有生成归档作品";
      checks.push({ name: "archive_writing", status: "no_action", reason: noActionReason, nextEligibleAt: null });
      await deps.saveState();
      action = { type: "do_nothing", reason: noActionReason };
    }
  } else if (decision.action === "group_proactive") {
    executed = "group_proactive";
    const groupResult = await deps.runGroupProactiveAction();
    if (groupResult.actions.length > 0) {
      const modes = Array.from(new Set(groupResult.actions.map((groupAction) => groupAction.mode))).join("/");
      checks.push({
        name: "group_proactive",
        status: "acted",
        reason: `产生 ${groupResult.actions.length} 个主动开口动作（${modes}）`,
        nextEligibleAt: null,
      });
      action = { type: "send_group_message", reason: "group proactive policy produced an action", actions: groupResult.actions };
    } else {
      const noActionReason = "没有群聊同时通过冷场、兴趣话题、冷却和限流规则";
      checks.push({ name: "group_proactive", status: "no_action", reason: noActionReason, nextEligibleAt: null });
      action = { type: "do_nothing", reason: noActionReason };
    }
  } else {
    action = { type: "do_nothing", reason: decision.reason || "no due autonomy action" };
  }

  // Trace entries for the three candidates that weren't executed this tick:
  // either they were never eligible (the real reason, computed above), or
  // they were eligible but the judge picked something else. "deferred" no
  // longer means "a higher-priority check preempted me" (there is no more
  // priority order) -- it now means "the judge had this option and passed".
  const deferredEntry = (name: AutonomyCheckName): AutonomyCheck => ({
    name,
    status: "deferred",
    reason: "模型本轮选择优先做别的",
    nextEligibleAt: null,
  });
  if (executed !== "world_observation") checks.push(worldNotDueCheck ?? deferredEntry("world_observation"));
  if (executed !== "memory_reflection") checks.push(memoryNotDueCheck ?? deferredEntry("memory_reflection"));
  if (executed !== "archive_writing") checks.push(archiveNotDueCheck ?? deferredEntry("archive_writing"));
  if (executed !== "group_proactive") checks.push(deferredEntry("group_proactive"));

  return { action, checks };
}
