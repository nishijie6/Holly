// Open-Jev 影子判断：搜索结果值不值得打开，让本地的 Open-Jev 决策模型也答一遍。
//
// Open-Jev（github.com/siliconflow/Open-Jev，fork 自 Zefan-Cai/Open-Jev）是 TypeSafe Jev 的
// 开源复刻：Qwen3.5 基座 + LoRA + 一个标量决策头，输入 state 和带类型的问题，直接给概率，不
// 生成 token。它和 NanoJev 是同一类东西，所以挂在同一个位置、答同一道题（题面见
// search-judge-shadow.ts），日志分开记，两份可以直接比。
//
// 只用 2B。9B 用 bf16 常驻就要 14.78 GiB，这台 M4 只有 16 GB 统一内存，还要分给系统、
// Holly 和 SearXNG；27B 更不用想。Open-Jev 文档里的数字都来自 CUDA，MPS 能不能跑、跑多快
// 是在这台机器上自己测的。
//
// 跟 NanoJev 一样只做影子信号，永远不参与真实决定。理由也一样：它的训练集几乎全是英文
// （客服、游戏、画图、推理题），中文只出现在一份明确没进训练的 mailroom 数据里，拿来判中文
// 新闻链接属于换了一个域，零样本效果没有依据。准不准先看 openjev-eval.ts 在历史标签上跑出
// 来的数字，再看影子日志里跟 主模型 的分歧。
//
// 协议上和 NanoJev 的差别：NanoJev 是一批独立状态、每个状态一道题；Open-Jev 是一个共享
// state 配多道题。所以这里把话题和时间窗放进 state，每条搜索结果变成一道 noul（是非）题，
// 结果本身放在题目的 instructions 里——照 Open-Jev 自带 rag_filter 示例的写法，query 在
// state、passage 在题里。每道 noul 在服务端都是一条独立序列（上下文 + 题目），互不可见，
// 所以一批送多少条不影响单条的结果，只影响耗时。
//
// 服务不在、超时、返回读不懂，一律返回 null，意思是「这次没有影子信号」，不是「模型说不
// 留」。
//
// —— 2026-09-25 首次实测结论（Open-Jev-2B，MPS bf16，M4 16 GB）——
//
// 和 NanoJev 不同，它确实在答这道题。十条冒烟样例 p_true 极差 0.852（NanoJev 是 0.057），
// 对 9/10；唯一的「错」是那条 AGMAI 公告，它讲数学与 AI、话题却是天文学，按题面判丢反而对。
//
// 历史标签（监控日志 890 条，按话题和 url 去重后 keep 49 / 按类型丢 45，见 openjev-eval.ts）
// 上 AUC 0.941；只给 url、不给标题掉到 0.792，生产里还有摘要，只会比这好。但要老实记一笔：
// 不训练的 Qwen3.5-2B 基座用同一套题面，AUC 也有 0.926。排序能力大半是 Qwen 自带的，
// Open-Jev 的训练买到的主要是校准——基座把乱码域名、空白页也打到 0.5～0.6，所有分数挤在
// 0.4～0.9；训练过的把垃圾压到 0.01 上下，分数铺得开，线才好划。
//
// 代价：每条 0.46 秒左右（每条候选一条独立序列，没开前缀缓存），服务进程常驻约 5.7 GB。

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

/** 推理服务地址：python -m jev.server 默认监听 127.0.0.1:8791。 */
export type OpenJevRuntimeConfig = SearchJudgeShadowConfig;

export const DEFAULT_OPENJEV_CONFIG: OpenJevRuntimeConfig = {
  // 默认关着，理由和 NanoJev 一样：服务是个单独拉起来的 Python 进程，没起来的时候每次搜索
  // 都白连一次。
  enabled: false,
  url: "http://127.0.0.1:8791",
  // 影子调用被 void 掉，谁也不等它，超时丢掉的只是一条数据。给足，免得 MPS 上偶尔的慢批
  // 把本来能拿到的数据丢掉。
  timeoutMs: 30_000,
  // 不是 0.5。主模型 那边的题面有一句「拿不准就留」，对只给概率的模型，这句话就该翻成一条
  // 低线，而不是写进题目。2026-09-25 在历史标签上扫出来（openjev-eval.ts，样本内）：0.5 会把
  // 49 条该留的丢掉 36 条，0.10 时留对 40/49、丢对 41/45。影子日志记的是原始 p_true，换线
  // 可以在日志上重算，不用重跑。
  threshold: 0.1,
};

/**
 * 单次最多送多少条。服务端自己的上限（4096 道题）远高于此；这个数是为了把一次影子调用的
 * 耗时压在可预期的范围里——搜索一般只回十条上下，超过 32 条只判前 32 条。
 */
export const OPENJEV_MAX_RESULTS = 32;

function questionId(index: number): string {
  return `r${index}/keep`;
}

export function buildOpenJevSearchRequest(input: SearchJudgeShadowInput): {
  state: Record<string, string>;
  questions: Record<string, unknown>;
} {
  const state: Record<string, string> = {
    now: `${input.nowLabel} (Beijing time)`,
    window_starts: input.sinceLabel,
    topic: input.topic,
  };
  if (input.topicBrief) state.topic_scope = input.topicBrief;

  const questions: Record<string, unknown> = {};
  input.results.forEach((result, offset) => {
    questions[questionId(offset + 1)] = {
      type: "noul",
      instructions: {
        task: SEARCH_KEEP_INSTRUCTIONS,
        result: {
          title: result.title || "(untitled)",
          url: result.url,
          snippet: result.snippet || "(none)",
        },
      },
      criteria: SEARCH_KEEP_CRITERIA,
    };
  });
  return { state, questions };
}

/**
 * 把服务的回答读成逐条判断。只认 [0,1] 内的有限概率：服务端虽然校验过分布，读到的毕竟是
 * 外部进程的输出，一个 NaN 混进日志会把后面的统计全带歪。一条都读不出来就返回 null。
 */
export function parseOpenJevSearchResponse(
  parsed: unknown,
  judgedCount: number,
  threshold: number,
): { verdicts: SearchJudgeVerdict[]; serverSeconds: number | null } | null {
  if (!isRecord(parsed) || !isRecord(parsed.answers)) return null;
  const verdicts: SearchJudgeVerdict[] = [];
  for (let index = 1; index <= judgedCount; index += 1) {
    const answer = parsed.answers[questionId(index)];
    if (!isRecord(answer) || answer.type !== "noul") continue;
    const pTrue = finiteNumber(answer.noul);
    if (pTrue === null || pTrue < 0 || pTrue > 1) continue;
    verdicts.push({ index, pTrue, keep: pTrue >= threshold });
  }
  if (verdicts.length === 0) return null;
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : null;
  return { verdicts, serverSeconds: finiteNumber(metadata?.inference_seconds) };
}

export async function judgeSearchResultsWithOpenJev(
  config: OpenJevRuntimeConfig,
  input: SearchJudgeShadowInput,
): Promise<SearchJudgeShadowJudgement | null> {
  if (!config.enabled || input.results.length === 0) return null;

  // 超限只判前面那些，而不是整批放弃：影子数据少几条无妨，整批放弃会让结果多的话题永远
  // 没有数据。
  const judged = input.results.slice(0, OPENJEV_MAX_RESULTS);
  const skipped = input.results.length - judged.length;

  let parsed: unknown;
  try {
    const response = await fetch(new URL("/v1/systemone", config.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildOpenJevSearchRequest({ ...input, results: judged })),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) return null;
    parsed = await response.json();
  } catch {
    return null;
  }

  const read = parseOpenJevSearchResponse(parsed, judged.length, config.threshold);
  if (!read) return null;
  return { verdicts: read.verdicts, forwardPasses: null, serverSeconds: read.serverSeconds, skipped };
}

// CLI: npm run openjev:test   （需要 jev.server 已在 8791 就绪）
//
// 不进 npm test，它要一个外部推理服务。跑的是和 NanoJev 同一组十条冒烟样例，所以两边的
// 极差可以直接对比：NanoJev 零样本是 0.057。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2] ?? DEFAULT_OPENJEV_CONFIG.url;
  const startedAt = Date.now();
  const judgement = await judgeSearchResultsWithOpenJev(
    { ...DEFAULT_OPENJEV_CONFIG, url, enabled: true, timeoutMs: 300_000 },
    SEARCH_JUDGE_SMOKE_INPUT,
  );
  if (!judgement) {
    console.error("返回 null —— 服务没就绪、超时，或返回格式跟解析假设不符。");
    console.error(`先确认 curl ${url}/health 通。`);
    process.exit(1);
  }
  console.log(`round_trip_seconds=${((Date.now() - startedAt) / 1000).toFixed(3)}`);
  printSmokeReport(judgement);
}
