// Open-Jev 离线评测：拿 主模型 过去在「搜索结果值不值得打开」上的判断当标签，看本地决策模型
// 能不能分得开。
//
// 标签从 logs/monitor.jsonl 里的「World Observation Search Judged」条目读出来，每条是一批
// url 的 keep / drop（带中文理由）。直接拿来用有三个坑，这里逐个处理：
//
// 1. 重复。同一个话题下同一个 url 被判了几十次（同一组搜索词每小时都搜），原始条数看着有
//    八九百，按（话题, url）去重之后只有一百出头。评测按去重后的算，报告里两个数都写。
//
// 2. 时效。主模型 丢掉一条的理由有两类：「这是百科 / 课程 / 工具页」是页面类型，跟什么时候
//    判无关；「8月4日文章，超出时间窗口」是时效，依赖当时的日期和摘要。监控日志里没记标题和
//    摘要，时效类标签在这里根本无法复现，所以主指标只看「留」对「按类型丢」；按时效丢的单列
//    一行，只报它们的平均概率，不算进 AUC。同一个 url 有时留、有时因时效被丢，说明它是新闻类
//    页面，按「留」算。同一个 url 既被留过、又被按类型丢过，是 主模型 自己前后不一致，排除。
//
// 3. 输入不全。生产里送给模型的是搜索结果的标题、url、摘要；这里只有 url。标题现去抓页面的
//    <title> 补上（页面类型不随时间变，现在的标题和当时搜索结果的标题基本同源），抓不到就
//    写 (untitled)，摘要一律 (none)。抓过的标题缓存在 logs/openjev-eval-titles.json，重跑
//    不会再抓。所以这里的数字是生产效果的下界：少了摘要这条最有用的信息。
//
// 跑：npm run eval:openjev                       （默认 http://127.0.0.1:8791）
//     npm run eval:openjev -- http://host:port    （换个服务，比如不带训练的基座做对照）
//     npm run eval:openjev -- --no-titles         （只给 url，看标题贡献多少）

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import YAML from "yaml";

import { DEFAULT_OPENJEV_CONFIG, judgeSearchResultsWithOpenJev } from "./openjev-judge.js";
import { freshnessWindowLabels } from "./world-observation-freshness.js";

// ---------- 从监控日志读标签 ----------

export type JudgedSearchEntry = {
  ts: string;
  topic: string;
  kept: string[];
  dropped: Array<{ url: string; reason: string }>;
};

/** 解析一行监控日志；不是「Search Judged」条目或读不懂就返回 null。 */
export function parseSearchJudgedLine(line: string): JudgedSearchEntry | null {
  if (!line.includes("World Observation Search Judged")) return null;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null) return null;
  const { ts, title, body } = record as Record<string, unknown>;
  if (title !== "World Observation Search Judged" || typeof ts !== "string" || typeof body !== "string") return null;
  const lines = body.split("\n");
  if (!lines[0]?.startsWith("topic=")) return null;
  const entry: JudgedSearchEntry = { ts, topic: lines[0].slice("topic=".length).trim(), kept: [], dropped: [] };
  for (const raw of lines.slice(1)) {
    if (raw.startsWith("keep ")) entry.kept.push(raw.slice(5).trim());
    else if (raw.startsWith("drop ")) {
      const [url, ...reason] = raw.slice(5).split(" | ");
      entry.dropped.push({ url: url.trim(), reason: reason.join(" | ").trim() });
    }
  }
  return entry;
}

export type DropKind = "type" | "freshness" | "other";

// 类型信号优先：「学习资料博客，时间过旧」既是学习资料又过旧，但光凭类型它就该丢，不管
// 什么时候判。只有没有任何类型信号、只剩时间信号的，才算时效类。
const TYPE_REASON = /非新闻|百科|学习|课本|教材|课程|教程|入门|科普|概论|工具|产品|问答|论坛|词典|招生|无关|竞赛|资料|基础知识|主页/;
const FRESHNESS_REASON = /窗口|天前|小时前|过期|过旧|过时|旧文章|旧报告|近期|\d+月|\d{4}年/;

export function classifyDropReason(reason: string): DropKind {
  if (TYPE_REASON.test(reason)) return "type";
  if (FRESHNESS_REASON.test(reason)) return "freshness";
  return "other";
}

export type EvalLabel = "keep" | "drop_type" | "drop_freshness" | "conflict" | "other";

export type EvalItem = {
  topic: string;
  url: string;
  label: EvalLabel;
  /** 这个（话题, url）在日志里被判过多少次。 */
  occurrences: number;
  reasons: string[];
  /**
   * 评测时告诉模型的「现在」。保留的取最后一次被留下的时间，其余取最后一次被判的时间。
   * 不能统一用同一个时间点：标题里带日期的新闻（「科学热点小时报丨2026年09月17日」）放到
   * 一周后再问，按题面它就是该丢的，那等于拿评测的错去扣模型的分。
   */
  contextTs: string;
};

/**
 * 按（话题, url）合并多次判断。规则见文件头：类型丢弃和保留同时出现算冲突；有过保留、其余
 * 只是时效丢弃，算保留；只有类型丢弃，算类型丢；只有时效丢弃，算时效丢。
 */
export function aggregateEvalItems(entries: readonly JudgedSearchEntry[]): EvalItem[] {
  type Slot = {
    topic: string;
    url: string;
    keep: number;
    drops: Array<{ kind: DropKind; reason: string }>;
    lastKeptTs: string;
    lastSeenTs: string;
  };
  const byKey = new Map<string, Slot>();
  const slot = (topic: string, url: string, ts: string) => {
    const key = `${topic}\u0000${url}`;
    let value = byKey.get(key);
    if (!value) {
      value = { topic, url, keep: 0, drops: [], lastKeptTs: "", lastSeenTs: "" };
      byKey.set(key, value);
    }
    if (ts > value.lastSeenTs) value.lastSeenTs = ts;
    return value;
  };
  for (const entry of entries) {
    for (const url of entry.kept) {
      const value = slot(entry.topic, url, entry.ts);
      value.keep += 1;
      if (entry.ts > value.lastKeptTs) value.lastKeptTs = entry.ts;
    }
    for (const { url, reason } of entry.dropped) {
      slot(entry.topic, url, entry.ts).drops.push({ kind: classifyDropReason(reason), reason });
    }
  }
  const items: EvalItem[] = [];
  for (const value of byKey.values()) {
    const typeDrops = value.drops.filter((drop) => drop.kind === "type").length;
    const freshDrops = value.drops.filter((drop) => drop.kind === "freshness").length;
    let label: EvalLabel;
    if (value.keep > 0 && typeDrops > 0) label = "conflict";
    else if (typeDrops > 0) label = "drop_type";
    else if (value.keep > 0) label = "keep";
    else if (freshDrops > 0) label = "drop_freshness";
    else label = "other";
    items.push({
      topic: value.topic,
      url: value.url,
      label,
      occurrences: value.keep + value.drops.length,
      reasons: [...new Set(value.drops.map((drop) => drop.reason))],
      contextTs: label === "keep" ? value.lastKeptTs : value.lastSeenTs,
    });
  }
  return items;
}

// ---------- 指标 ----------

/**
 * ROC AUC，按秩算（Mann–Whitney U），并列取平均秩。0.5 是瞎猜，1 是完美分开。它不依赖判定
 * 线，所以回答的是「分不分得开」，跟阈值定在哪无关。
 */
export function rocAuc(positives: readonly number[], negatives: readonly number[]): number | null {
  if (positives.length === 0 || negatives.length === 0) return null;
  const all = [
    ...positives.map((score) => ({ score, positive: true })),
    ...negatives.map((score) => ({ score, positive: false })),
  ].sort((left, right) => left.score - right.score);
  let rankSumPositive = 0;
  for (let start = 0; start < all.length;) {
    let end = start;
    while (end + 1 < all.length && all[end + 1].score === all[start].score) end += 1;
    const averageRank = (start + end) / 2 + 1;
    for (let index = start; index <= end; index += 1) {
      if (all[index].positive) rankSumPositive += averageRank;
    }
    start = end + 1;
  }
  const n = positives.length;
  return (rankSumPositive - (n * (n + 1)) / 2) / (n * negatives.length);
}

/** 以「p >= 线」判留，遍历每个出现过的分数当线，返回平衡准确率最高的那条。 */
export function bestBalancedThreshold(
  positives: readonly number[],
  negatives: readonly number[],
): { threshold: number; balancedAccuracy: number } | null {
  if (positives.length === 0 || negatives.length === 0) return null;
  let best: { threshold: number; balancedAccuracy: number } | null = null;
  for (const threshold of new Set([...positives, ...negatives])) {
    const balancedAccuracy = (positives.filter((p) => p >= threshold).length / positives.length
      + negatives.filter((p) => p < threshold).length / negatives.length) / 2;
    if (!best || balancedAccuracy > best.balancedAccuracy) best = { threshold, balancedAccuracy };
  }
  return best;
}

function describe(values: readonly number[]): string {
  if (values.length === 0) return "n=0";
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  return `n=${values.length} 均值=${mean.toFixed(3)} 标准差=${sd.toFixed(3)}`
    + ` 范围=[${Math.min(...values).toFixed(3)}, ${Math.max(...values).toFixed(3)}]`;
}

// ---------- 标题 ----------

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

/** 从 HTML 字节里取 <title>。国内站点不少还是 GBK，所以先按 meta/header 里的字符集解码。 */
export function extractTitle(bytes: Uint8Array, contentType: string): string {
  const sniff = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const charset = (/charset=["']?([\w-]+)/i.exec(contentType)?.[1]
    ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1]
    ?? "utf-8").toLowerCase();
  let html: string;
  try {
    html = new TextDecoder(charset).decode(bytes);
  } catch {
    html = new TextDecoder("utf-8").decode(bytes);
  }
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

async function fetchTitle(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36" },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!response.ok) return "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    return extractTitle(bytes, response.headers.get("content-type") ?? "");
  } catch {
    return "";
  }
}

async function loadTitles(urls: readonly string[], cachePath: string): Promise<Map<string, string>> {
  const cache: Record<string, string> = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, "utf-8")) as Record<string, string>
    : {};
  const missing = urls.filter((url) => !(url in cache));
  // 八路并发：一百来个 url，串行要好几分钟；开太多又容易被同一个站限流。
  for (let start = 0; start < missing.length; start += 8) {
    const batch = missing.slice(start, start + 8);
    const titles = await Promise.all(batch.map(fetchTitle));
    batch.forEach((url, offset) => { cache[url] = titles[offset]; });
  }
  if (missing.length > 0) writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  // 反爬挑战页的标题（khanacademy 回的就是 Client Challenge）比没有标题更糟：它会让模型
  // 以为这是个跟话题无关的页面。读的时候当作没抓到，缓存里原样留着，换规则不用重抓。
  return new Map(Object.entries(cache).map(([url, title]) => [url, BOT_CHALLENGE_TITLE.test(title) ? "" : title]));
}

const BOT_CHALLENGE_TITLE = /^(client challenge|just a moment|attention required|access denied)/i;

// ---------- CLI ----------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appRoot = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const useTitles = !args.includes("--no-titles");
  const url = args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_OPENJEV_CONFIG.url;

  const entries = readFileSync(join(appRoot, "logs", "monitor.jsonl"), "utf-8")
    .split("\n")
    .map(parseSearchJudgedLine)
    .filter((entry): entry is JudgedSearchEntry => entry !== null);
  const items = aggregateEvalItems(entries);
  const rawCount = entries.reduce((sum, entry) => sum + entry.kept.length + entry.dropped.length, 0);
  const count = (label: EvalLabel) => items.filter((item) => item.label === label).length;
  console.log(`监控日志：${entries.length} 次判断，${rawCount} 条原始标签，去重后 ${items.length} 个（话题, url）`);
  console.log(`  keep=${count("keep")} drop_type=${count("drop_type")} drop_freshness=${count("drop_freshness")}`
    + ` conflict=${count("conflict")} other=${count("other")}`);

  const scored = items.filter((item) => item.label !== "conflict" && item.label !== "other");
  const titles = useTitles
    ? await loadTitles(scored.map((item) => item.url), join(appRoot, "logs", "openjev-eval-titles.json"))
    : new Map<string, string>();
  if (useTitles) {
    const withTitle = scored.filter((item) => titles.get(item.url)).length;
    console.log(`  标题：${withTitle}/${scored.length} 条抓到了`);
  }

  // 话题简介用当前配置里的，和生产一致；「现在」用每条自己的 contextTs（见 EvalItem）。
  const config = YAML.parse(readFileSync(join(appRoot, "config.yaml"), "utf-8")) as
    { autonomy?: { world_topic_briefs?: Record<string, string> } } | null;
  const briefs = config?.autonomy?.world_topic_briefs ?? {};

  const scores = new Map<EvalItem, number>();
  const startedAt = Date.now();
  let serverSeconds = 0;
  // 一次请求共享一个 state（话题 + 现在 + 时间窗），所以按（话题, 现在）分组。每道题在服务端
  // 是独立序列，分组只影响请求次数，不影响单条的分数。
  const groups = new Map<string, EvalItem[]>();
  for (const item of scored) {
    const key = `${item.topic}\u0000${item.contextTs}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const group of groups.values()) {
    const topic = group[0].topic;
    const labels = freshnessWindowLabels(Date.parse(group[0].contextTs));
    for (let start = 0; start < group.length; start += 16) {
      const chunk = group.slice(start, start + 16);
      const judgement = await judgeSearchResultsWithOpenJev(
        { ...DEFAULT_OPENJEV_CONFIG, url, enabled: true, timeoutMs: 600_000 },
        {
          topic,
          topicBrief: briefs[topic] ?? "",
          nowLabel: labels.now,
          sinceLabel: labels.since,
          results: chunk.map((item) => ({ title: titles.get(item.url) ?? "", url: item.url, snippet: "" })),
        },
      );
      if (!judgement) {
        console.error(`\n${topic} 第 ${start / 16 + 1} 批返回 null —— 服务没就绪、超时，或返回格式不对。先确认 curl ${url}/health 通。`);
        process.exit(1);
      }
      serverSeconds += judgement.serverSeconds ?? 0;
      for (const verdict of judgement.verdicts) scores.set(chunk[verdict.index - 1], verdict.pTrue);
      process.stdout.write(".");
    }
  }
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`\n推理：${scores.size} 条，往返 ${elapsed.toFixed(1)} 秒，服务端 ${serverSeconds.toFixed(1)} 秒`
    + `（每条 ${(serverSeconds / Math.max(1, scores.size)).toFixed(2)} 秒）`);

  const byLabel = (label: EvalLabel) => scored.filter((item) => item.label === label && scores.has(item))
    .map((item) => scores.get(item) as number);
  const keep = byLabel("keep");
  const dropType = byLabel("drop_type");
  const dropFresh = byLabel("drop_freshness");
  console.log(`\np_true  keep           ${describe(keep)}`);
  console.log(`p_true  drop_type      ${describe(dropType)}`);
  console.log(`p_true  drop_freshness ${describe(dropFresh)}  （不计入主指标）`);

  const auc = rocAuc(keep, dropType);
  console.log(`\nAUC（keep 对 drop_type）= ${auc === null ? "?" : auc.toFixed(3)}   0.5=瞎猜 1=完美分开`);
  const threshold = DEFAULT_OPENJEV_CONFIG.threshold;
  const tp = keep.filter((p) => p >= threshold).length;
  const tn = dropType.filter((p) => p < threshold).length;
  console.log(`阈值 ${threshold}：keep 判对 ${tp}/${keep.length}，drop_type 判对 ${tn}/${dropType.length}，`
    + `平衡准确率 ${((tp / Math.max(1, keep.length) + tn / Math.max(1, dropType.length)) / 2).toFixed(3)}`);
  // 阈值扫描是在同一批数据上挑线，数字偏乐观，只用来看「线大概该落在哪一带」，不能当成上线
  // 后的准确率。
  console.log("阈值扫描（样本内，偏乐观）：");
  for (const line of [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5]) {
    const keepHit = keep.filter((p) => p >= line).length;
    const dropHit = dropType.filter((p) => p < line).length;
    console.log(`  ${line.toFixed(2)}  keep ${keepHit}/${keep.length}  drop_type ${dropHit}/${dropType.length}`
      + `  平衡准确率 ${((keepHit / Math.max(1, keep.length) + dropHit / Math.max(1, dropType.length)) / 2).toFixed(3)}`);
  }
  // 固定档位是照着训练过的模型挑的；没训练过的基座概率全挤在 0.4～0.9，档位对它不公平。
  // 所以再遍历每个出现过的分数当线，报各自的最好成绩，两个模型才能放在一起比。
  const best = bestBalancedThreshold(keep, dropType);
  if (best) {
    console.log(`最佳阈值（样本内，偏乐观）= ${best.threshold.toFixed(3)}  平衡准确率 ${best.balancedAccuracy.toFixed(3)}`);
  }

  // 最该看的两类错：把 主模型 留下的判得最低（会让她少看东西），把按类型该丢的判得最高。
  const worst = (label: EvalLabel, direction: 1 | -1) => scored
    .filter((item) => item.label === label && scores.has(item))
    .sort((left, right) => direction * ((scores.get(left) as number) - (scores.get(right) as number)))
    .slice(0, 5);
  console.log("\nkeep 里分最低的五条：");
  for (const item of worst("keep", 1)) {
    console.log(`  p=${(scores.get(item) as number).toFixed(3)} [${item.topic}] ${titles.get(item.url) || "(untitled)"} ${item.url}`);
  }
  console.log("drop_type 里分最高的五条：");
  for (const item of worst("drop_type", -1)) {
    console.log(`  p=${(scores.get(item) as number).toFixed(3)} [${item.topic}] ${titles.get(item.url) || "(untitled)"} ${item.url} | ${item.reasons[0] ?? ""}`);
  }
}
