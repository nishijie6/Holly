export type BroadcastHistoryTurn = {
  role: string;
  content: string;
  timestamp: string;
};

export type RecentBroadcastItem = {
  text: string;
  url: string;
  normalizedUrl: string;
  timestampMs: number;
};

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const TRAILING_URL_PUNCTUATION = /[。，、；;！!？?）)\]}]+$/u;
const TRACKING_QUERY_PARAM = /^(utm_[a-z0-9_]+|spm|from|source|ref|referrer|share_source)$/i;

export function normalizeBroadcastUrl(rawUrl: string): string {
  const clean = rawUrl.trim().replace(TRAILING_URL_PUNCTUATION, "");
  try {
    const parsed = new URL(clean);
    parsed.hash = "";
    // 带不带 www. 是同一个站点的同一篇文章。不去掉的话，nao.cas.cn 和 www.nao.cas.cn 上的
    // 同一条新闻会被当成两条——2026-09-02 到 09-09 之间就这样重复发过两次。
    // 规范化的结果只用来比较，发出去的链接保持原样。
    parsed.hostname = parsed.hostname.replace(/^www\./, "");
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_QUERY_PARAM.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return clean.replace(/^(https?:\/\/)www\./i, "$1");
  }
}

function normalizeBroadcastText(text: string): string {
  return text
    .replace(URL_PATTERN, " ")
    .replace(/^\s*\d+[.、]\s*/u, "")
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, "");
}

function characterNgrams(text: string, size = 3): Set<string> {
  const grams = new Set<string>();
  if (text.length < size) return grams;
  for (let index = 0; index <= text.length - size; index += 1) {
    grams.add(text.slice(index, index + size));
  }
  return grams;
}

export function broadcastTextSimilarity(left: string, right: string): number {
  const a = normalizeBroadcastText(left);
  const b = normalizeBroadcastText(right);
  if (a.length < 12 || b.length < 12) return 0;
  if (a === b) return 1;
  const aGrams = characterNgrams(a);
  const bGrams = characterNgrams(b);
  let intersection = 0;
  for (const gram of aGrams) {
    if (bGrams.has(gram)) intersection += 1;
  }
  return (2 * intersection) / (aGrams.size + bGrams.size);
}

export function isDuplicateBroadcastText(
  text: string,
  recentTexts: readonly string[],
  threshold = 0.58,
): boolean {
  return recentTexts.some((recent) => broadcastTextSimilarity(text, recent) >= threshold);
}

export function containsChineseText(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

const OBSERVATION_HEADER_PATTERN = /^\[Browser observation\] query=/;
const OBSERVATION_TITLE_LINE_PATTERN = /^\d+\. .+$/;
const OBSERVATION_SOURCE_LINE_PATTERN = /^Source: https?:\/\/\S+$/;
const OBSERVATION_DETAIL_LINKS_HEADER_PATTERN = /^Detail links:$/;
const OBSERVATION_DETAIL_LINK_LINE_PATTERN = /^- .+: https?:\/\/\S+$/;

// Strips the scaffolding formatObservationSummary (browser-agent.ts) wraps
// around each page's excerpt — the "[Browser observation] query=" header,
// numbered "N. Title" lines, "Source: url" lines, and the trailing "Detail
// links:" block — leaving just the scraped article prose. Line-based rather
// than one multi-line regex so each stripped element stays easy to verify.
export function extractSummaryProse(summary: string): string {
  const kept: string[] = [];
  let inDetailLinks = false;
  for (const line of summary.split(/\r?\n/)) {
    if (OBSERVATION_HEADER_PATTERN.test(line)) continue;
    if (OBSERVATION_DETAIL_LINKS_HEADER_PATTERN.test(line)) {
      inDetailLinks = true;
      continue;
    }
    if (inDetailLinks) {
      if (OBSERVATION_DETAIL_LINK_LINE_PATTERN.test(line)) continue;
      inDetailLinks = false;
    }
    if (OBSERVATION_TITLE_LINE_PATTERN.test(line)) continue;
    if (OBSERVATION_SOURCE_LINE_PATTERN.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

const MIN_FALLBACK_PROSE_CHARS = 60;
const MAX_FALLBACK_TEXT_CHARS = 150;

// Safety net for when the structured LLM extraction pass (main.ts's
// translateWorldObservationForBroadcast) returns no items despite a summary
// that browser-agent already judged usable (isUsableArticleExcerpt: >=150
// chars, no bot-wall phrases). Rather than reporting the source as noise —
// the "误杀" pattern Holly's own memory reflection flagged repeatedly on
// 2026-08-19 — quote a chunk of the raw prose directly, the same workaround
// Holly had been doing by hand.
export function buildFallbackBroadcastItem(
  summary: string,
  urls: readonly string[],
): { text: string; url: string } | null {
  const prose = extractSummaryProse(summary).replace(/\s+/g, " ").trim();
  if (prose.length < MIN_FALLBACK_PROSE_CHARS || !containsChineseText(prose)) return null;
  const url = urls[0];
  if (!url) return null;
  const text = prose.length <= MAX_FALLBACK_TEXT_CHARS
    ? prose
    : `${prose.slice(0, MAX_FALLBACK_TEXT_CHARS - 3)}...`;
  return { text, url };
}

export function extractRecentBroadcastItems(
  turns: readonly BroadcastHistoryTurn[],
  nowMs: number,
  windowMs: number,
): RecentBroadcastItem[] {
  const cutoff = nowMs - windowMs;
  const items: RecentBroadcastItem[] = [];
  for (const turn of turns) {
    if (turn.role !== "assistant" || turn.content.startsWith("世界观察失败:")) continue;
    const timestampMs = Date.parse(turn.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs < cutoff || timestampMs > nowMs) continue;
    for (const line of turn.content.split(/\r?\n/)) {
      const urls = line.match(URL_PATTERN) ?? [];
      for (const rawUrl of urls) {
        const url = rawUrl.replace(TRAILING_URL_PUNCTUATION, "");
        const text = line.replace(rawUrl, " ").replace(/^\s*\d+[.、]\s*/u, "").trim();
        if (!text || !url) continue;
        items.push({ text, url, normalizedUrl: normalizeBroadcastUrl(url), timestampMs });
      }
    }
  }
  return items;
}
