// 每次 LLM 调用都必须声明用途，该标签会随调用产生的用量一起记录。「哪个调用点
// 一直在重写前缀」取决于谁写入、谁读回缓存，单看每日总量回答不了；如果在消费端
// 才补标签，它还可能与真正产生用量的调用错位。
export type LlmCallPurpose =
  | "reply-decision"
  | "reply-response"
  | "reply-search-reask"
  | "world-observation-broadcast"
  | "world-observation-search-judge"
  | "world-observation-share-decision"
  | "memory-reflection"
  | "archive-composition"
  | "proactive-decision"
  | "proactive-response"
  | "boot-orientation"
  | "qq-mode-decision"
  | "autonomy-judgment"
  | "focus-loop"
  | "ledger-compaction"
  // 她闲下来时冒念头，以及随后她自己动手的那一轮。两者都复用焦点前缀，所以缓存命中率
  // 应当和 focus-loop 一个量级——掉下去就说明前缀被谁弄漂了。
  | "inner-voice"
  | "inner-thought"
  | "eval-script";

export type TokenUsageBreakdown = {
  inputTokens: number;
  uncachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  // 最后一个 cache_control 断点之前的前缀估算大小，也是缓存条目唯一可能覆盖的部分。
  // 不报告断点的提供方（Codex）以及开始记录该字段之前的旧数据没有此值，只能退回用
  // 整个请求的大小判断；这正是过去把 1.1 万 token 请求里的 40-token 前缀误判为
  // 前缀漂移的原因。
  cacheablePrefixTokens?: number;
};

// 这里有意只做估算，不充当分词器：它只需判断前缀是否跨过 512/1024/2048/4096
// 的阈值。若前缀离边界近到估算误差会影响结果，应从设计上留出余量，而不是继续追求
// 测量精度。中日韩字符约按一字一个 token，其余字符约按四字一个 token 计算。
export function estimatePromptTokens(text: string): number {
  let cjk = 0;
  let total = 0;
  for (const char of text) {
    total += 1;
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x3040 && code <= 0x30ff)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk += 1;
    }
  }
  return Math.round(cjk + (total - cjk) / 4);
}

export type CallTokenUsage = TokenUsageBreakdown & {
  model: string;
  purpose: LlmCallPurpose;
  capturedAt: number;
};

export type ModelTokenCounts = TokenUsageBreakdown & {
  // 明细结构出现前记录的输入无法可靠归类；保留其可见性，不假装它属于未缓存输入。
  unattributedInputTokens: number;
  // 整个请求短于模型最小可缓存前缀的输入。它虽未命中缓存，却不可能通过优化前缀被
  // 缓存，因此不计入命中率分母（见 minimumCacheablePrefixTokens），避免被误读为
  // 可以修复的缓存未命中。
  uncacheableInputTokens: number;
};

export type ModelTokenStat = ModelTokenCounts & {
  model: string;
  totalTokens: number;
  // read / (read + write + uncached)；没有可缓存输入记录时为 null，与 0% 命中不同。
  hitRate: number | null;
};

export type DailyTokenStats = {
  date: string;
  models: ModelTokenStat[];
  totalTokens: number;
};

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export class TokenUsageQueue {
  private readonly model: string;
  private readonly now: () => number;
  private readonly queue: CallTokenUsage[] = [];

  constructor(model: string, now: () => number = () => Date.now()) {
    this.model = model;
    this.now = now;
  }

  record(usage: TokenUsageBreakdown, purpose: LlmCallPurpose): void {
    this.queue.push({
      model: this.model,
      purpose,
      inputTokens: tokenCount(usage.inputTokens),
      uncachedInputTokens: tokenCount(usage.uncachedInputTokens),
      cacheCreationInputTokens: tokenCount(usage.cacheCreationInputTokens),
      cacheReadInputTokens: tokenCount(usage.cacheReadInputTokens),
      outputTokens: tokenCount(usage.outputTokens),
      ...(typeof usage.cacheablePrefixTokens === "number"
        ? { cacheablePrefixTokens: tokenCount(usage.cacheablePrefixTokens) }
        : {}),
      capturedAt: this.now(),
    });
  }

  consume(): CallTokenUsage | null {
    return this.queue.shift() ?? null;
  }
}

export function normalizeStoredTokenCounts(value: unknown): ModelTokenCounts {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const inputTokens = tokenCount(record.inputTokens);
  const uncachedInputTokens = tokenCount(record.uncachedInputTokens);
  const cacheCreationInputTokens = tokenCount(record.cacheCreationInputTokens);
  const cacheReadInputTokens = tokenCount(record.cacheReadInputTokens);
  const categorized = uncachedInputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const unattributedInputTokens = "unattributedInputTokens" in record
    ? tokenCount(record.unattributedInputTokens)
    : Math.max(0, inputTokens - categorized);

  return {
    inputTokens,
    uncachedInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    unattributedInputTokens,
    // 该分类出现前写入的旧记录没有这个字段；这些调用当时按普通未命中统计，不能事后
    // 追溯性地把它们排除。
    uncacheableInputTokens: tokenCount(record.uncacheableInputTokens),
    outputTokens: tokenCount(record.outputTokens),
  };
}

// belowMinimum 会把本次调用的输入计入「不可缓存」而非「未缓存」。二者都没有由缓存
// 提供，但只有「未缓存」属于可通过改进前缀避免的未命中，因此也只有它进入命中率分母。
export function addCallTokenUsage(
  counts: ModelTokenCounts,
  usage: TokenUsageBreakdown,
  belowMinimum = false,
): ModelTokenCounts {
  const uncached = tokenCount(usage.uncachedInputTokens);
  return {
    inputTokens: counts.inputTokens + tokenCount(usage.inputTokens),
    uncachedInputTokens: counts.uncachedInputTokens + (belowMinimum ? 0 : uncached),
    cacheCreationInputTokens:
      counts.cacheCreationInputTokens + tokenCount(usage.cacheCreationInputTokens),
    cacheReadInputTokens: counts.cacheReadInputTokens + tokenCount(usage.cacheReadInputTokens),
    unattributedInputTokens: counts.unattributedInputTokens,
    uncacheableInputTokens: counts.uncacheableInputTokens + (belowMinimum ? uncached : 0),
    outputTokens: counts.outputTokens + tokenCount(usage.outputTokens),
  };
}

// 命中率只在这里定义。单次调用、每日表格、小时序列和按用途汇总都从这里取百分比，
// 避免仪表盘与日志中的同一数字含义不一致。
export function derivePromptCacheHitRate(counts: {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
}): number | null {
  const read = tokenCount(counts.cacheReadInputTokens);
  const eligible = read
    + tokenCount(counts.cacheCreationInputTokens)
    + tokenCount(counts.uncachedInputTokens);
  return eligible === 0 ? null : read / eligible;
}

export function buildDailyTokenStats(
  date: string,
  models: Map<string, ModelTokenCounts> | undefined,
): DailyTokenStats {
  const list: ModelTokenStat[] = [];
  let totalTokens = 0;
  if (models) {
    for (const [model, counts] of models) {
      const total = counts.inputTokens + counts.outputTokens;
      totalTokens += total;
      list.push({ model, ...counts, totalTokens: total, hitRate: derivePromptCacheHitRate(counts) });
    }
  }
  list.sort((left, right) => right.totalTokens - left.totalTokens);
  return { date, models: list, totalTokens };
}

// Anthropic 会静默拒绝缓存短于模型下限的前缀：不报错，只会一直返回
// cache_creation_input_tokens: 0。不同代际模型的下限并非单调变化，因此必须查表，
// 不能靠经验规则推断。未知模型返回 null；只有明确知道调用低于哪个阈值时，才把它
// 排除在命中率分母之外。
const MINIMUM_CACHEABLE_PREFIX_TOKENS: ReadonlyArray<readonly [prefix: string, minimum: number]> = [
  ["claude-opus-4-8", 1_024],
  ["claude-opus-4-7", 2_048],
  ["claude-opus-4-6", 4_096],
  ["claude-opus-4-5", 4_096],
  ["claude-opus-4-1", 1_024],
  ["claude-opus-5", 512],
  ["claude-opus-4", 1_024],
  ["claude-fable-5", 512],
  ["claude-mythos-5", 512],
  ["claude-sonnet-5", 1_024],
  ["claude-sonnet-4-6", 1_024],
  ["claude-sonnet-4-5", 1_024],
  ["claude-sonnet-4", 1_024],
  ["claude-haiku-4-5", 4_096],
  ["claude-haiku-3-5", 2_048],
];

export function minimumCacheablePrefixTokens(model: string): number | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  // 必须优先匹配最长名称，避免 "claude-opus-4-7" 错配到 "claude-opus-4"。
  for (const [prefix, minimum] of MINIMUM_CACHEABLE_PREFIX_TOKENS) {
    if (normalized.startsWith(prefix)) return minimum;
  }
  return null;
}

// 记录调用无法缓存的原因。下面两种问题对应不同修复方式，不能合并；混在一起曾让人
// 在只有 40 token 前缀的路由上徒劳排查前缀漂移：
//   request-too-small —— 整个请求低于模型下限。该大小天然不可缓存，应调整请求长度、
//     模型选择或调用频率，而不是整理前缀；它不计入命中率。
//   prefix-too-small —— 请求本身够大，但断点前的部分太短。缓存条目仍不可能产生，
//     可请求中的大部分内容原本能被正确放置的断点覆盖。这是可修复的配置问题，所以
//     仍按真实的 0% 计入命中率。
export type PromptCacheUncacheableReason = "request-too-small" | "prefix-too-small";

export type PromptCacheCallSummary = {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
  accountedInputTokens: number;
  // 本次调用已统计输入中由缓存提供的比例。路由是否真正复用前缀必须逐次判断，每日
  // 总量回答不了；调用本身不具备缓存资格（belowMinimum）时为 null。
  hitRate: number | null;
  // 模型的最小可缓存前缀；模型不在上表中时为 null。
  minimumPrefixTokens: number | null;
  // 断点前缀的估算大小；请求未报告该值时为 null。
  cacheablePrefixTokens: number | null;
  // 本次调用不可能存在缓存条目时设置；两种情况的含义见上方原因码。
  uncacheableReason: PromptCacheUncacheableReason | null;
  // 保持原有的窄语义，仅表示「本次调用不计入命中率」：只有 request-too-small 时
  // 为 true，prefix-too-small 仍属于真实未命中。
  belowMinimum: boolean;
};

// 提供方没有报告分类明细时返回 null（这正是 unattributedInputTokens 保留可见的缺口）。
// 对从未测量过的调用报告 0% 命中是在编造数字，并不代表真实未命中。
export function summarizePromptCacheCall(
  usage: TokenUsageBreakdown,
  model = "",
): PromptCacheCallSummary | null {
  const uncachedInputTokens = tokenCount(usage.uncachedInputTokens);
  const cacheCreationInputTokens = tokenCount(usage.cacheCreationInputTokens);
  const cacheReadInputTokens = tokenCount(usage.cacheReadInputTokens);
  const accountedInputTokens =
    uncachedInputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  if (accountedInputTokens === 0) {
    return null;
  }

  const minimumPrefixTokens = minimumCacheablePrefixTokens(model);
  const prefixTokens = typeof usage.cacheablePrefixTokens === "number"
    ? Math.max(0, usage.cacheablePrefixTokens)
    : null;
  // 只要出现任何缓存活动，就证明请求已跨过下限；实测结果优先于静态表格。
  const noCacheActivity = cacheReadInputTokens === 0 && cacheCreationInputTokens === 0;

  // 缓存条目只能覆盖断点前的前缀，而非整个请求；只要请求报告了前缀长度，就用它与
  // 下限比较。未报告时退回按整个请求判断，这是旧有且较粗的检查：它只可能漏诊，
  // 不会凭空制造这种诊断。
  let uncacheableReason: PromptCacheUncacheableReason | null = null;
  if (minimumPrefixTokens !== null && noCacheActivity) {
    if (accountedInputTokens < minimumPrefixTokens) {
      uncacheableReason = "request-too-small";
    } else if (prefixTokens !== null && prefixTokens < minimumPrefixTokens) {
      uncacheableReason = "prefix-too-small";
    }
  }
  const belowMinimum = uncacheableReason === "request-too-small";

  return {
    cacheReadInputTokens,
    cacheCreationInputTokens,
    uncachedInputTokens,
    accountedInputTokens,
    hitRate: belowMinimum ? null : cacheReadInputTokens / accountedInputTokens,
    minimumPrefixTokens,
    cacheablePrefixTokens: prefixTokens,
    uncacheableReason,
    belowMinimum,
  };
}

// 小时桶和调用用途使用同一套计数结构，使小时序列与按用途汇总共享同一个分母定义。
export type PromptCacheCounts = {
  calls: number;
  uncacheableCalls: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
  uncacheableInputTokens: number;
  outputTokens: number;
};

export function emptyPromptCacheCounts(): PromptCacheCounts {
  return {
    calls: 0,
    uncacheableCalls: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    uncachedInputTokens: 0,
    uncacheableInputTokens: 0,
    outputTokens: 0,
  };
}

export function normalizeStoredPromptCacheCounts(value: unknown): PromptCacheCounts {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    calls: tokenCount(record.calls),
    uncacheableCalls: tokenCount(record.uncacheableCalls),
    cacheReadInputTokens: tokenCount(record.cacheReadInputTokens),
    cacheCreationInputTokens: tokenCount(record.cacheCreationInputTokens),
    uncachedInputTokens: tokenCount(record.uncachedInputTokens),
    uncacheableInputTokens: tokenCount(record.uncacheableInputTokens),
    outputTokens: tokenCount(record.outputTokens),
  };
}

export function addSummaryToPromptCacheCounts(
  counts: PromptCacheCounts,
  summary: PromptCacheCallSummary,
  outputTokens: number,
): PromptCacheCounts {
  return {
    calls: counts.calls + 1,
    uncacheableCalls: counts.uncacheableCalls + (summary.belowMinimum ? 1 : 0),
    cacheReadInputTokens: counts.cacheReadInputTokens + summary.cacheReadInputTokens,
    cacheCreationInputTokens: counts.cacheCreationInputTokens + summary.cacheCreationInputTokens,
    uncachedInputTokens:
      counts.uncachedInputTokens + (summary.belowMinimum ? 0 : summary.uncachedInputTokens),
    uncacheableInputTokens:
      counts.uncacheableInputTokens + (summary.belowMinimum ? summary.uncachedInputTokens : 0),
    outputTokens: counts.outputTokens + tokenCount(outputTokens),
  };
}

export type PromptCacheStat = PromptCacheCounts & {
  inputTokens: number;
  hitRate: number | null;
};

function toPromptCacheStat(counts: PromptCacheCounts): PromptCacheStat {
  return {
    ...counts,
    inputTokens: counts.cacheReadInputTokens
      + counts.cacheCreationInputTokens
      + counts.uncachedInputTokens
      + counts.uncacheableInputTokens,
    hitRate: derivePromptCacheHitRate(counts),
  };
}

export type PromptCacheSeriesPoint = PromptCacheStat & { bucket: string };

// 本地时区的小时键。该序列会与同样按本地时间统计的每日表格并排展示，两者必须对
// 一天的起点保持一致。
export function localHourKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}`;
}

// 按从旧到新生成每小时一个且不中断的条目。Holly 休眠的一小时应显示为 hitRate=null
// 的点，而不是缺失横轴刻度、悄悄把相隔很久的两个小时拼在一起。
export function listRecentHourKeys(now: Date, hours: number): string[] {
  const count = Math.max(1, Math.floor(hours));
  const anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    keys.push(localHourKey(new Date(anchor.getTime() - offset * 3_600_000)));
  }
  return keys;
}

export function buildPromptCacheSeries(
  buckets: Map<string, PromptCacheCounts> | undefined,
  hourKeys: readonly string[],
): PromptCacheSeriesPoint[] {
  return hourKeys.map((bucket) => ({
    bucket,
    ...toPromptCacheStat(buckets?.get(bucket) ?? emptyPromptCacheCounts()),
  }));
}

export type PromptCachePurposeStat = PromptCacheStat & { purpose: string };

// 按用途分开汇总，才看得出哪个调用点在写缓存、哪个在读回来——合成一个总数，
// 只写不读的用途会把读得好的用途的命中率一起拉下去。
export function buildPromptCachePurposeStats(
  purposes: Map<string, PromptCacheCounts> | undefined,
): PromptCachePurposeStat[] {
  const list: PromptCachePurposeStat[] = [];
  if (purposes) {
    for (const [purpose, counts] of purposes) {
      list.push({ purpose, ...toPromptCacheStat(counts) });
    }
  }
  list.sort((left, right) => right.inputTokens - left.inputTokens);
  return list;
}
