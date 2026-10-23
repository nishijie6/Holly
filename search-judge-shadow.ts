// 搜索结果筛选的影子判官：题面、对照、冒烟样例，几个本地决策模型共用这一份。
//
// 这一步由 主模型 做真实决定（main.ts 的 judgeWorldObservationSearchResults），本地决策模型
// 只在旁边并排答同一道题、记一笔分歧，永远不参与决定。NanoJev（nanojev-judge.ts）和
// Open-Jev（openjev-judge.ts）说的协议不同，但题面、判定线、跟 主模型 的对照方式必须是同一
// 套——否则两份影子日志之间没法比，也分不清分歧是模型的差别还是题目的差别。所以凡是「答
// 什么题、怎么算一致」的东西都放在这里，各自的文件只管怎么把题送到自己的服务、怎么把概率
// 读回来。

export type SearchJudgeShadowConfig = {
  enabled: boolean;
  /** 推理服务地址。 */
  url: string;
  /** 单次请求超时。影子信号宁可丢掉，也不能拖住调用方。 */
  timeoutMs: number;
  /** p_true 到「留」的判定线。只影响影子日志里的 keep 字段，不影响任何真实行为。 */
  threshold: number;
};

export type SearchJudgeShadowInput = {
  topic: string;
  topicBrief: string;
  nowLabel: string;
  sinceLabel: string;
  results: readonly { title: string; url: string; snippet: string }[];
};

export type SearchJudgeVerdict = {
  /** 对应传进来的结果下标，从 1 开始，跟 主模型 那边的编号口径一致。 */
  index: number;
  /** 模型给的「值得打开」概率。 */
  pTrue: number;
  /** pTrue >= threshold。 */
  keep: boolean;
};

export type SearchJudgeShadowJudgement = {
  verdicts: SearchJudgeVerdict[];
  /**
   * 服务报告的前向次数。NanoJev 用它证明「一次前向算完一批」；Open-Jev 每条候选是独立序列、
   * 按批次切分，服务不报这个数，记 null。
   */
  forwardPasses: number | null;
  /** 服务端自己测的推理耗时（秒）。 */
  serverSeconds: number | null;
  /** 因为超过单批上限而没送去判断的结果条数。 */
  skipped: number;
};

// 问题文本刻意照抄 buildSearchResultJudgePrompt 的那几条标准。两个模型答的必须是同一
// 道题，否则日志里的分歧分不清是能力差别还是题目差别——那样这份影子数据就白攒了。
export const SEARCH_KEEP_INSTRUCTIONS = [
  "This result is worth opening for a news update on the topic below.",
  "It is true when the result is likely a news article, a news or research-update listing,",
  "or an announcement page that keeps getting new items.",
  "It is false for encyclopedia and dictionary entries, courses and learning material,",
  "beginner explainers, Q&A and forum threads, tool or product home pages,",
  "anything outside the topic scope, and anything whose snippet clearly dates it",
  "before the window given in the state.",
].join(" ");

export const SEARCH_KEEP_CRITERIA = {
  true: "Worth opening: likely a news article, an updating listing, or an announcement page within the topic and window.",
  false: "Not worth opening: reference or learning material, off-topic, a tool home page, or clearly older than the window.",
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 影子对比的结果，写进日志的就是这个形状。
 *
 * 逐条列出两边的判断，再给一个 agree/disagree 计数。统计值本来可以在读日志的时候现
 * 算，但写下来的好处是：改了阈值之后，旧记录里的一致率仍然是当时那条线下的真实结论，
 * 不会被新阈值追溯性地改写。
 */
export type SearchJudgeShadowComparison = {
  agree: number;
  disagree: number;
  /** 影子模型说留、主模型 说丢。 */
  shadowOnlyKeep: number;
  /** 主模型 说留、影子模型说丢——这一类是真正危险的，代表它会让 Holly 少看东西。 */
  primaryOnlyKeep: number;
  rows: Array<{
    index: number;
    url: string;
    primaryKeep: boolean;
    shadowKeep: boolean;
    pTrue: number;
    reason: string;
  }>;
};

export function compareSearchJudgements(input: {
  results: readonly { url: string }[];
  /** 主模型 判定留下的结果下标（从 1 开始）。 */
  primaryKeptIndexes: ReadonlySet<number>;
  /** 主模型 给出的丢弃理由，按下标。 */
  primaryReasons: ReadonlyMap<number, string>;
  judgement: { verdicts: readonly SearchJudgeVerdict[] };
}): SearchJudgeShadowComparison {
  const comparison: SearchJudgeShadowComparison = {
    agree: 0, disagree: 0, shadowOnlyKeep: 0, primaryOnlyKeep: 0, rows: [],
  };
  for (const verdict of input.judgement.verdicts) {
    const primaryKeep = input.primaryKeptIndexes.has(verdict.index);
    if (primaryKeep === verdict.keep) comparison.agree += 1;
    else {
      comparison.disagree += 1;
      if (verdict.keep) comparison.shadowOnlyKeep += 1;
      else comparison.primaryOnlyKeep += 1;
    }
    comparison.rows.push({
      index: verdict.index,
      url: input.results[verdict.index - 1]?.url ?? "",
      primaryKeep,
      shadowKeep: verdict.keep,
      pTrue: Number(verdict.pTrue.toFixed(4)),
      reason: input.primaryReasons.get(verdict.index) ?? "",
    });
  }
  return comparison;
}

// ---------- 冒烟样例 ----------
//
// 十条候选分两组，上半该留、下半该丢，两边差异故意拉得很大：真新闻列表、真公告，对上维基、
// Coursera、知乎、淘宝首页、乱码域名、空白页。它不是准确率评测（那个看 openjev-eval.ts 跑
// 的历史标签），它回答的是更前面的问题：这个 checkpoint 到底有没有在答这道题。NanoJev 零
// 样本在这十条上的 p_true 全挤在 0.826～0.883，极差 0.057——说明输出跟输入无关。

const SMOKE_SHOULD_KEEP = [
  { title: "中国科学院紫金山天文台", url: "http://www.pmo.cas.cn/", snippet: "紫金山天文台科研动态、最新论文与观测进展，持续更新。" },
  { title: "Space and Astronomy News", url: "https://starwalk.space/zh-Hans/news", snippet: "2026年9月最新天文新闻：本月可见行星、流星雨与日食预报。" },
  { title: "Astronomy and Astrophysics - Latest research", url: "https://phys.org/space-news/", snippet: "Daily coverage of astronomy and space research, updated continuously." },
  { title: "AGMAI 成立公告", url: "https://www.ias.edu/news/agmai-2026", snippet: "普林斯顿高等研究院宣布成立数学与人工智能顾问组，2026年9月21日。" },
];
const SMOKE_SHOULD_DROP = [
  { title: "天文学 - 维基百科，自由的百科全书", url: "https://zh.wikipedia.org/wiki/天文学", snippet: "天文学是研究宇宙空间天体、宇宙结构和发展的学科。本条目介绍其历史与分支。" },
  { title: "Introduction to Astronomy | Coursera", url: "https://www.coursera.org/learn/astro", snippet: "本课程面向初学者，共 8 周，讲解恒星演化基础知识。立即免费注册。" },
  { title: "为什么星星会闪烁？ - 知乎", url: "https://www.zhihu.com/question/20140091", snippet: "17 个回答 · 大气湍流导致的视差抖动…… 3 年前" },
  { title: "淘宝网 - 淘！我喜欢", url: "https://www.taobao.com/", snippet: "女装 男装 童装 家电 数码 每日特价" },
  { title: "asdkjhqwe", url: "http://x.invalid/zzz", snippet: "zzzz qqqq 乱码乱码乱码" },
  { title: "", url: "about:blank", snippet: "(empty)" },
];

export const SEARCH_JUDGE_SMOKE_INPUT: SearchJudgeShadowInput = {
  topic: "天文学",
  topicBrief: "天文观测、航天任务与天体物理研究的最新进展",
  nowLabel: "2026-09-22 20:30",
  sinceLabel: "2026-09-21 20:30",
  results: [...SMOKE_SHOULD_KEEP, ...SMOKE_SHOULD_DROP],
};

/** 冒烟样例里第 index 条（从 1 开始）的人工预期。 */
export function smokeExpectation(index: number): boolean {
  return index <= SMOKE_SHOULD_KEEP.length;
}

/**
 * 打印冒烟结果。判据是 p_true 的极差：挤在一条窄带里就说明这个 checkpoint 在本任务上没有
 * 判别力，别开 enabled；拉开了才值得看逐条对错。
 */
export function printSmokeReport(judgement: SearchJudgeShadowJudgement): void {
  const results = SEARCH_JUDGE_SMOKE_INPUT.results;
  console.log(`forward_passes=${judgement.forwardPasses ?? "?"}`
    + ` server_seconds=${judgement.serverSeconds?.toFixed(3) ?? "?"} skipped=${judgement.skipped}\n`);
  let hit = 0;
  for (const verdict of judgement.verdicts) {
    const want = smokeExpectation(verdict.index);
    if (verdict.keep === want) hit += 1;
    console.log(
      `${verdict.keep === want ? "✓" : "✗"} p_true=${verdict.pTrue.toFixed(4)}`
      + ` 期望=${want ? "keep" : "drop"} ${results[verdict.index - 1].url}`,
    );
  }
  const probabilities = judgement.verdicts.map((verdict) => verdict.pTrue);
  const mean = probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length;
  const sd = Math.sqrt(probabilities.reduce((sum, value) => sum + (value - mean) ** 2, 0) / probabilities.length);
  const spread = Math.max(...probabilities) - Math.min(...probabilities);
  console.log(`\n与人工预期一致 ${hit}/${judgement.verdicts.length}`);
  console.log(`p_true 均值=${mean.toFixed(4)} 标准差=${sd.toFixed(4)} 极差=${spread.toFixed(4)}`);
  console.log(spread < 0.15
    ? "→ 概率挤在一条窄带里，这个 checkpoint 在本任务上没有判别力，别开 enabled。"
    : "→ 概率拉开了，值得看逐条对错并考虑进入影子期。");
}
