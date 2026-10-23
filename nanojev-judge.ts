// NanoJev 影子判断：搜索结果值不值得打开，让一个本地小模型也答一遍。
//
// NanoJev 是个 0.6B 的决策模型，输入状态和问题，直接输出候选的概率分布，不生成任何
// token（见 https://github.com/TianyuCodings/NanoJev）。它跟 Holly 别的调用点都合不
// 上——那些要么是 agentic 工具循环，要么产出的是自由文本，而它只会给概率。搜索结果
// 筛选是唯一形状对得上的：一批结果、每条一个「留不留」的布尔判断，正好是它「一次前向
// 里并排算完多个独立状态」的用法。
//
// 这里只做影子信号，跟 ai-tone 一样的规矩：跟 主模型 的判断并排记一笔，永远不参与
// 真实决定。原因不是谨慎过头——它是在 ViZDoom、迷宫、贪吃蛇那几个游戏的一万八千条
// 决策上微调出来的，拿来判断中文新闻链接属于彻底换了一个域，零样本效果没有任何保证。
// ai-tone.ts 开头那条 topic-bias 警告说的是同一件事。要让它有发言权，得先攒够它和
// 主模型 的分歧样本，看清它在哪类结果上系统性偏一边。
//
// 服务不在、超时、返回读不懂，一律当作「这次没有影子信号」，返回 null。影子信号缺一
// 次不损失任何东西，但它绝不该让 Holly 的搜索流程慢一拍或者多一个失败点。
//
// —— 2026-09-22 首次实测结论（unified-games-v1，MPS fp32）——
//
// 零样本状态下这个 checkpoint 在本任务上没有判别力：拿十条差异极大的候选去问（三个真
// 新闻列表、维基条目、Coursera 课程页、知乎问答，外加空白页、乱码域名、淘宝首页、一条
// 真公告），p_true 全部落在 0.826～0.883 这条 0.057 宽的带里，标准差 0.012。维基百科那
// 条还拿到了全场最高分。换句话说它输出的近似是个常数，跟输入内容无关——不是判得不准，
// 是压根没在答这道题。符合预期：决策头是在 ViZDoom 和迷宫的状态空间上训练的。
//
// 所以 config 里默认关着，不是因为谨慎，而是因为现在开只会往日志里灌一串 0.85。要让它
// 有意义，得先用 monitor.jsonl 里那 839 条历史标签（keep 389 / drop 450）做一次微调，
// 再用底部那个 CLI 重测——判据就是 p_true 的极差和标准差能不能拉开。
//
// 一次前向算完整批这件事是真的：forward_passes=1，六条候选 2.6 秒、四条 1.1 秒（MPS
// fp32，含首次预热）。所以并行决策这个卖点成立，缺的只是这个域的训练。

// 题面、跟 主模型 的对照、冒烟样例都在 search-judge-shadow.ts，跟 Open-Jev 共用；这里只管
// NanoJev 自己的协议：/api/evaluate，一批独立状态、每个状态一道 boolean 题。

import { pathToFileURL } from "node:url";

import {
  SEARCH_JUDGE_SMOKE_INPUT,
  SEARCH_KEEP_CRITERIA,
  SEARCH_KEEP_INSTRUCTIONS,
  finiteNumber,
  isRecord,
  printSmokeReport,
  type SearchJudgeShadowConfig,
  type SearchJudgeShadowInput,
  type SearchJudgeShadowJudgement,
  type SearchJudgeVerdict,
} from "./search-judge-shadow.js";

/** 推理服务地址：serve_decisions.py 默认监听 127.0.0.1:8765。 */
export type NanoJevRuntimeConfig = SearchJudgeShadowConfig;

export const DEFAULT_NANOJEV_CONFIG: NanoJevRuntimeConfig = {
  // 默认关着：推理服务是个需要单独拉起来的 Python 进程，没起来的时候每次搜索都去连
  // 一个必然失败的地址、再吞掉异常，只是白费一次往返。要用它得显式打开。
  enabled: false,
  url: "http://127.0.0.1:8765",
  // 实测每条候选 0.28~0.43 秒（MPS fp32），十来条结果就能超过原来定的 4 秒。影子调用是
  // 被 void 掉的，慢一点谁也不等它，所以宁可给足——超时丢掉的是数据，不是时间。
  timeoutMs: 15000,
  threshold: 0.5,
};

/** 服务端每批的上限，超过就直接 400。见 serve_decisions.py 的 do_POST。 */
export const NANOJEV_MAX_STATES = 32;

// 状态用纯文本拼。validate_request 允许字符串、对象或数组，但它自己的注释说字符串
// 「最贴近本次训练数据」（与 trainer 的 f-string 序列化一致），所以这里不上 JSON。
function buildState(input: SearchJudgeShadowInput, result: { title: string; url: string; snippet: string }): string {
  return [
    `now: ${input.nowLabel} (Beijing time)`,
    `window starts: ${input.sinceLabel}`,
    `topic: ${input.topic}`,
    ...(input.topicBrief ? [`topic scope: ${input.topicBrief}`] : []),
    "",
    `title: ${result.title || "(untitled)"}`,
    `url: ${result.url}`,
    `snippet: ${result.snippet || "(none)"}`,
  ].join("\n");
}

/**
 * 问一遍 NanoJev。任何一步不顺就返回 null——调用方拿 null 的意思是「这次没有影子
 * 信号」，不是「模型说不留」。这两件事绝不能混：后者会让日志里凭空多出一堆假的分歧。
 */
export async function judgeSearchResultsWithNanoJev(
  config: NanoJevRuntimeConfig,
  input: SearchJudgeShadowInput,
): Promise<SearchJudgeShadowJudgement | null> {
  if (!config.enabled || input.results.length === 0) return null;

  // 超限就只判前 32 条，而不是整批放弃。影子数据少几条无妨，但一次 400 会让这条路
  // 在结果稍多的话题上永远没有数据。
  const judged = input.results.slice(0, NANOJEV_MAX_STATES);
  const skipped = input.results.length - judged.length;

  const payload = {
    states: judged.map((result, offset) => ({
      id: String(offset + 1),
      state: buildState(input, result),
      questions: {
        keep: { type: "boolean", instructions: SEARCH_KEEP_INSTRUCTIONS, criteria: SEARCH_KEEP_CRITERIA },
      },
    })),
  };

  let parsed: unknown;
  try {
    const response = await fetch(new URL("/api/evaluate", config.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) return null;
    parsed = await response.json();
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.states)) return null;

  const verdicts: SearchJudgeVerdict[] = [];
  for (const state of parsed.states) {
    if (!isRecord(state)) continue;
    const index = Number(state.id);
    if (!Number.isInteger(index) || index < 1 || index > judged.length) continue;
    const answers = isRecord(state.answers) ? state.answers : null;
    const answer = answers && isRecord(answers.keep) ? answers.keep : null;
    const pTrue = finiteNumber(answer?.p_true);
    // 只认真正落在 [0,1] 里的概率。服务端已经校验过分布合法，这里再挡一道是因为读
    // 到的毕竟是外部进程的输出，一个 NaN 混进日志会把后面所有统计带歪。
    if (pTrue === null || pTrue < 0 || pTrue > 1) continue;
    verdicts.push({ index, pTrue, keep: pTrue >= config.threshold });
  }
  if (verdicts.length === 0) return null;

  verdicts.sort((left, right) => left.index - right.index);
  const execution = isRecord(parsed.execution) ? parsed.execution : null;
  return {
    verdicts,
    forwardPasses: finiteNumber(execution?.forward_passes),
    serverSeconds: finiteNumber(execution?.server_evaluation_seconds),
    skipped,
  };
}

// CLI: npm run nanojev:test   （需要 serve_decisions.py 已在 8765 就绪）
//
// 这不是单元测试，不进 npm test——它要一个外部推理服务。它是「这个 checkpoint 现在能
// 不能用」的判据，样例和判据见 search-judge-shadow.ts。零样本时极差约 0.06；微调之后
// 如果这个数字没有明显拉开，就说明还是不能用。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const judgement = await judgeSearchResultsWithNanoJev(
    { ...DEFAULT_NANOJEV_CONFIG, enabled: true, timeoutMs: 60_000 },
    SEARCH_JUDGE_SMOKE_INPUT,
  );
  if (!judgement) {
    console.error("返回 null —— 服务没就绪、超时，或返回格式跟解析假设不符。");
    console.error(`先确认 curl ${DEFAULT_NANOJEV_CONFIG.url}/api/health 通。`);
    process.exit(1);
  }
  printSmokeReport(judgement);
}
