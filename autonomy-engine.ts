import type {
  ProactiveTickResult,
  ProactiveWorldObservation,
} from "./proactive-engine.js";
import {
  evaluateAutonomyTrigger,
  type AutonomyIdlePolicy,
} from "./autonomy-idle.js";

/**
 * 这个循环一轮能有的结局。
 *
 * 观察世界、写记忆、写作品都不在这里了——它们是她手边的子工具，什么时候用由她自己那一轮
 * 决定，这个循环看不见也不需要看见。剩下的两个是它仍然亲自发起的：按规则闸主动开口，
 * 或者冒一个念头交给她。
 */
export type AutonomyAction =
  | { type: "do_nothing"; reason: string }
  | { type: "send_group_message"; reason: string; actions: ProactiveTickResult["actions"] }
  | { type: "inner_thought"; reason: string };

export type AutonomyCheckName =
  | "world_observation"
  | "memory_reflection"
  | "archive_writing"
  | "inner_voice"
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
  // worldObservationBroadcastGroupId。一个话题可以配多个群：同一条内容、同一次「发不发」的判断，
  // 每个群再各自过自己的冷场闸。配置里写单个群号也照收，main.ts 读进来时统一成列表。
  worldTopicBroadcastGroupOverrides: Record<string, string[]>;
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
  archiveWritingRetryMs: number;
  /**
   * 归档写作一天最多几次。
   *
   * 不是节奏闸——什么时候想写由她自己判断。这是防跑飞的兜底：模型抽了风连着挑二十次
   * 归档写作，得有个东西拦住。以前这个位置是 240 分钟的固定间隔，它顺带兜住了这件事；
   * 间隔一撤，兜底就得自己站出来。
   */
  archiveWritingDailyCap: number;
  /** 世界观察一天最多几次。同样是防跑飞，不是节奏闸——见 archiveWritingDailyCap。 */
  worldObservationDailyCap: number;
};

// ---------- 世界观察播报的目标群 ----------

type BroadcastRoutingConfig = Pick<
  AutonomyConfig,
  | "worldObservationBroadcastGroupId"
  | "worldTopicBroadcastGroupOverrides"
>;

// 这个话题要发进哪几个群。键按话题原文逐字匹配，写法必须和 worldTopics 一致。
//
// 监控页上的开关直接改这份名单，所以「配了、但是空的」是一个有意义的状态：一个群都没选就是这个
// 话题不播报，绝不能落回默认群——否则关掉最后一个开关，它反而跑去默认群发。只有从没配过这个话题
// （键都不存在）才落回默认群。
export function resolveWorldObservationBroadcastGroupIds(
  config: BroadcastRoutingConfig,
  topic: string,
): string[] {
  const override = config.worldTopicBroadcastGroupOverrides[topic];
  if (override !== undefined) return [...new Set(override)];
  return config.worldObservationBroadcastGroupId ? [config.worldObservationBroadcastGroupId] : [];
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
    // flat()：一个话题可以配多个群，漏了这一步这里拿到的是数组，会被下面的字符串过滤悄悄丢掉，
    // 那个群发过的内容就不参与去重了。
    ...Object.values(config.worldTopicBroadcastGroupOverrides).flat(),
  ];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

/**
 * 最近一次真的落到纸面上的自主动作，只记题目不记正文。
 *
 * 为什么只有记忆反思和归档写作：世界观察那条线已经有 worldTopicLines 逐话题报上次
 * 看的时间和结果，主动开口由 proactive 那边自己的规则闸管着，只有这两个动作是「她挑
 * 一个题目、写一段东西」，而判断层对写过什么一无所知——它看到的只有「archive_writing:
 * 可选」。连着三轮写同一件事，从提示词里是看不出来的。
 *
 * 不记正文是有意的：判断调用每分钟一次、短到吃不上缓存，每个字都按全价重付。题目足够
 * 回答「这个是不是刚写过」，正文只会把这次调用撑大。
 */
export type RecentAutonomyAction = {
  kind: "memory_reflection" | "archive_writing";
  at: number;
  /** 那一次的题目：记忆的 topic、作品的 title。 */
  title: string;
};

/** 往回看几条。够看出「最近一直在绕着同一件事打转」，又不至于让判断提示词变长。 */
export const RECENT_AUTONOMY_ACTION_LIMIT = 6;

/**
 * 判断调用连着失败多少次才开始缓一缓。
 *
 * 一次失败不算事：网络抖一下、模型偶尔吐个解析不了的 JSON，下一分钟多半就好了，为这个
 * 停摆反而让她白白闲着。连着失败就不一样——那通常是凭证过期、模型下线、schema 和服务端
 * 对不上这类系统性故障，每分钟再问一次只会得到同一个错误，白烧一次调用。
 *
 * 调小：更快进入退避，省钱，但偶发抖动也会让她停一会儿。调大：抖动免疫更好，故障期间多烧
 * 几次调用。
 */
export const JUDGMENT_FAILURE_BACKOFF_THRESHOLD = 3;

/**
 * 进入退避后隔多久再试一次。
 *
 * 和 worldObservationRetryMs 同一个道理：失败之后才要缓一缓，成功之后不用等。退避期内整轮
 * 短路，连 judgment 都不调——她这一分钟不做事，但也不花钱。故障修好后的第一次成功会把计数
 * 清零，立刻回到每分钟一次。
 */
export const JUDGMENT_FAILURE_BACKOFF_MS = 10 * 60 * 1000;

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
  /** 最近若干次写下的题目，最新的在最后。老存档没有这个字段，读出来是空数组。 */
  recentActions: RecentAutonomyAction[];
  /** 上次真正发出判断调用的时刻，喂给触发门控算不应期。 */
  lastJudgmentAt: number;
  /** 判断调用连续失败了几次。成功一次即清零。 */
  judgmentFailureStreak: number;
  /** 最近一次判断调用失败的时刻，配合 streak 算退避到什么时候。 */
  lastJudgmentFailureAt: number;
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
  // 最近写过的题目，给判断层用来避开刚写过的东西。空数组表示还没写过，或是老存档刚升上来。
  recentActions: RecentAutonomyAction[];
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
  /**
   * 冒一个念头，然后让她自己去处理它。
   *
   * 这是这个循环现在唯一会发起的动作。以前它问模型「要不要做 A/B/C/D」、拿到答案再由引擎
   * 去执行那一个；记忆、写作、看世界现在都是她手边的子工具，所以这里不必再替她选——把念头
   * 递过去就够了，做什么、做不做是她自己那一轮的事。
   */
  emitInnerThought: () => Promise<void>;
  runGroupProactiveAction: () => Promise<ProactiveTickResult>;
  /**
   * 上次群里有动静的时刻（本次启动以来）。喂给触发门控判断她闲不闲——她正跟人说着话的
   * 时候，不该被这个循环拉去想自己的事。0 表示启动以来一直没动静，按闲处理。
   */
  lastFocusActivityAt: () => number;
  /** 触发门控的参数，测试用；不给就用默认。 */
  idlePolicy?: AutonomyIdlePolicy;
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

// 判断调用还在退避里吗——连续失败到阈值之后才开始算，单次失败不挡路。
// 形状照抄 worldObservationRetryAt：不存「退避到什么时候」，用「上次失败时刻 + 间隔」现算，
// 少一个会和 streak 不同步的状态字段。
function judgmentBackoffUntil(state: AutonomyLoopState, now: number): number | null {
  if ((state.judgmentFailureStreak ?? 0) < JUDGMENT_FAILURE_BACKOFF_THRESHOLD) return null;
  const until = (state.lastJudgmentFailureAt ?? 0) + JUDGMENT_FAILURE_BACKOFF_MS;
  return until > now ? until : null;
}

// 以前这里还有一道「距上次成功满 60 分钟」的闸，2026-09-15 取消：什么时候想去看看由 Holly 自己判断，
// 不按钟点排班。刚看完紧接着再去也放行——挡住无谓重复的是判断时看到的话题近况，不是时钟。
// 重试间隔只在失败后生效：成功之后不用等，失败之后才要缓一缓。
function worldObservationDue(cfg: AutonomyConfig, state: AutonomyLoopState, now: number): boolean {
  if (!cfg.worldObservationEnabled) return false;
  if (cfg.worldTopics.length === 0) return false;
  // 日上限是 2026-09-15 撤掉固定间隔时留下的洞：dailyCount 一直在加，却没有一处读它，
  // 于是那之后世界观察其实没有任何频率兜底。补上——它拦的是跑飞，不是节奏。
  if (state.worldObservationDailyCount >= cfg.worldObservationDailyCap) return false;
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

// 固定间隔在这里撤掉了，理由和世界观察 2026-09-15 那次一样：什么时候想写点东西由她自己
// 判断，不按钟点排班。人不会掐着表写诗。
//
// 撤得起，是因为这一条的间隔本来就不为缓存服务——归档写作永远读不回自己的 KV 缓存（见
// 「Reflect every 50 minutes」那次的实测），而缓存写入不额外收费，所以什么时候写在账单上
// 没有分别。记忆反思的 50 分钟是另一回事：它卡着一小时的 cache TTL，撤了命中率会从七成掉到
// 半成，所以那一条原样留着。
//
// 挡住无谓重复的，从此是判断时看到的事实——最近写过哪几个题目（recentActions）、上次是多久
// 以前——而不是时钟。retry 间隔照旧只在失败后生效。
function archiveWritingDue(cfg: AutonomyConfig, state: AutonomyLoopState, now: number): boolean {
  if (!cfg.archiveWritingEnabled) return false;
  if (state.archiveWritingDailyCount >= cfg.archiveWritingDailyCap) return false;
  if (
    state.lastArchiveWritingAttemptAt > 0 &&
    now - state.lastArchiveWritingAttemptAt < cfg.archiveWritingRetryMs
  ) {
    return false;
  }
  return true;
}

// 归档写作没有配置间隔了，不套 scheduledCheckWhenNotDue：没到期只可能是关着、今天写够了，
// 或者失败后在等重试。三个原因各自报实话，不写成「距上次尚未达到配置间隔」——那个间隔已经
// 不存在，那样写会让 trace 撒谎。
function archiveWritingCheckWhenNotDue(
  cfg: AutonomyConfig,
  state: AutonomyLoopState,
  now: number,
): AutonomyCheck {
  if (!cfg.archiveWritingEnabled) {
    return { name: "archive_writing", status: "disabled", reason: "归档写作已关闭", nextEligibleAt: null };
  }
  if (state.archiveWritingDailyCount >= cfg.archiveWritingDailyCap) {
    return {
      name: "archive_writing",
      status: "waiting",
      reason: `今天已经写了 ${state.archiveWritingDailyCount} 篇，到上限了`,
      nextEligibleAt: null,
    };
  }
  return {
    name: "archive_writing",
    status: "waiting",
    reason: "上次没写成，还在重试间隔里",
    nextEligibleAt: state.lastArchiveWritingAttemptAt + cfg.archiveWritingRetryMs,
  };
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

// 就地追加并裁到上限。调用点都在「写入成功」之后——没写成的那次不算数，她下一轮该
// 重新考虑这个题目，而不是以为自己已经写过了。
function rememberAutonomyAction(
  state: AutonomyLoopState,
  entry: RecentAutonomyAction,
): void {
  const title = entry.title.trim();
  if (!title) return;
  const list = state.recentActions ?? (state.recentActions = []);
  list.push({ ...entry, title });
  if (list.length > RECENT_AUTONOMY_ACTION_LIMIT) {
    list.splice(0, list.length - RECENT_AUTONOMY_ACTION_LIMIT);
  }
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

  // 这里曾经算三个定时候选的资格（间隔到没到、重试窗过没过、今天够没够），再据此决定要不要
  // 花那次判断调用。那套东西没有消费者了：观察世界、写记忆、写作品都成了她手边的子工具，
  // 什么时候用是她自己那一轮的判断，这个循环不再替她排班。
  //
  // 留着它反而是错的。归档写作还在重试间隔里，跟她此刻该不该冒个念头毫无关系——照旧短路的
  // 话，她会因为一件她根本没打算做的事而被按住不动。节奏现在只由下面那道门控管。
  //
  // 防跑飞也不再靠日上限：念头由门控限流（醒着时最多每 judgmentCooldownMs 一次），一轮之内
  // 她能调几次工具由 maxRounds 封顶，两头都有界。

  // 判断调用连着失败到阈值之后，缓一缓再问。单次失败不到这里——它照常降级成这一轮的
  // do_nothing，下一分钟接着问。挡住的是「凭证过期了，于是每分钟报同一个错烧同一笔钱，
  // 直到有人发现」那种跑法。
  const backoffUntil = judgmentBackoffUntil(state, now);
  if (backoffUntil !== null) {
    const minutes = Math.max(1, Math.round((backoffUntil - now) / 60_000));
    const reason = `判断调用已连续失败 ${state.judgmentFailureStreak} 次，暂停 ${minutes} 分钟后再试`;
    // 报成 waiting 而不是 deferred：这一轮不是模型挑了别的，是压根没问成。
    return {
      action: { type: "do_nothing", reason },
      checks: (["inner_voice", "group_proactive"] as const)
        .map((name) => ({ name, status: "waiting" as const, reason, nextEligibleAt: backoffUntil })),
    };
  }

  // 触发门控（零 LLM）：她闲不闲、刚问过没有、是不是深夜。排在连败退避之后——那条管的是
  // 故障，这条管的是常规节奏，故障优先。
  //
  // 放在候选资格算完之后也是有意的：没有任何候选可做时，上面那个短路已经返回了，根本轮不到
  // 这里；于是「不应期」只会被真正问得出东西的轮次消耗掉，不会被一串空轮白白用光。
  const verdict = evaluateAutonomyTrigger({
    now,
    signals: { lastJudgmentAt: state.lastJudgmentAt ?? 0, lastFocusActivityAt: deps.lastFocusActivityAt() },
    ...(deps.idlePolicy ? { policy: deps.idlePolicy } : {}),
  });
  if (!verdict.ask) {
    return {
      action: { type: "do_nothing", reason: verdict.reason },
      // 报 waiting：这一轮不是她挑了别的，是压根没问。和退避那条同一个口径。
      checks: (["inner_voice", "group_proactive"] as const)
        .map((name) => ({
          name,
          status: "waiting" as const,
          reason: verdict.reason,
          nextEligibleAt: verdict.nextEligibleAt,
        })),
    };
  }

  // 这一轮真的要动了。先记下时刻——不应期从发起算，不从结果算。
  state.lastJudgmentAt = now;
  await deps.saveState();

  // 主动开口优先。它有自己一整套规则闸（冷场时长、兴趣话题、冷却、限流、影子模式），
  // 那是单独设计过的安全边界，不该因为这里换了形状就被绕开。有活就让它去做，这一轮到此为止。
  if (deps.hasProactiveWork()) {
    const groupResult = await deps.runGroupProactiveAction();
    if (groupResult.actions.length > 0) {
      const modes = Array.from(
        new Set(groupResult.actions.map((groupAction: ProactiveTickResult["actions"][number]) => groupAction.mode)),
      ).join("/");
      return {
        action: {
          type: "send_group_message",
          reason: "group proactive policy produced an action",
          actions: groupResult.actions,
        },
        checks: [
          {
            name: "group_proactive",
            status: "acted",
            reason: `产生 ${groupResult.actions.length} 个主动开口动作（${modes}）`,
            nextEligibleAt: null,
          },
          ...deferredChecks(["inner_voice"], "这一轮先去主动开口了"),
        ],
      };
    }
  }

  // 没有别的事，就冒一个念头交给她。
  //
  // 这里不再问「要不要做 A/B/C/D」：记忆、写作、看世界都是她手边的子工具了，选哪个、选不选
  // 是她自己那一轮的判断。这个循环的职责缩到只剩「什么时候该冒念头」。
  try {
    await deps.emitInnerThought();
    // 成功一次就把连败清零：故障修好之后立刻恢复常态，不用等退避窗自然到期。
    state.judgmentFailureStreak = 0;
    state.lastJudgmentFailureAt = 0;
    await deps.saveState();
    return {
      action: { type: "inner_thought", reason: "闲下来了，冒个念头" },
      checks: [
        { name: "inner_voice", status: "acted", reason: "冒了个念头，接下来看她自己", nextEligibleAt: null },
        ...deferredChecks(["group_proactive"], "群聊规则闸未通过（冷场时长/冷却/限流）"),
      ],
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    state.judgmentFailureStreak = (state.judgmentFailureStreak ?? 0) + 1;
    state.lastJudgmentFailureAt = now;
    const streak = state.judgmentFailureStreak;
    deps.log(
      "error",
      "Inner voice failed",
      streak >= JUDGMENT_FAILURE_BACKOFF_THRESHOLD
        ? `连续第 ${streak} 次失败，接下来 ${Math.round(JUDGMENT_FAILURE_BACKOFF_MS / 60_000)} 分钟不再尝试：${detail}`
        : detail,
    );
    await deps.saveState();
    return {
      action: { type: "do_nothing", reason: `冒念头失败：${detail}` },
      checks: deferredChecks(["inner_voice", "group_proactive"], `冒念头失败：${detail}`),
    };
  }
}
