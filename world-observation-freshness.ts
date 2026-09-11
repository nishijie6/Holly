// 世界观察播报「只发今天的内容」的判断。
//
// 播报原先只靠去重挡重复：比链接、比文字相似度、回看七天。挡不住的是旧内容换个地址再出现——
// 91maths 的「换一批」列表页每次地址都不同，同一道「8 个 8 组成 1000」于是在 9 月发了八次；
// 博客园 2021 年的数学知识合集、腾讯新闻 8 月 2 日的旧稿，也都被当成「最新进展」播过。所以换
// 个角度卡：只发今天（北京时间）的内容。
//
// 页面分两种认法。文章页看元数据（article:published_time 一类的 meta、JSON-LD 的
// datePublished，由 browser-agent.ts 读出原始字符串）：声明的是今天，整页可用；是别的日子，
// 整页不要。列表页和首页没有自己的发布时间——猫目 AI 快讯、雷锋网、国家天文台首页都是这样，
// 而它们恰恰是「最新进展」搜出来最多的页面，只认元数据的话，2026-09-10 到 09-11 的 24 次观察
// 一次都发不出去。这类页面只在正文里确实写着今天的日期时才交给模型，并要求模型为每一条抄出
// 页面上标给它的日期原文，这里逐条核对：原文得真在那一页上，而且写的就是今天。
//
// 这比元数据弱：模型可能把别处的今天日期安到一条旧新闻头上。压低这种错的是两道规矩：证据必须
// 逐字出现在同一页；页头常驻的「2026年9月11日 星期五」这种时钟不算数——上海天文台首页就挂着
// 一个，底下的新闻却是 9 月 7 日的。

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// 群在国内，「今天」按北京时间算。中国不用夏令时，固定加 8 小时就够，不依赖运行环境的 TZ
// 和 ICU 数据，测试机和线上机器时区不同时结果也一样。
export function beijingDateKey(ms: number): string {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

// ---------- 文章页：元数据里的发布时间 ----------

const NUMERIC_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

function zoneOffsetMs(zone: string | undefined): number {
  // 国内站点的 meta 经常只写「2026-08-02 17:00:59」不带时区（腾讯新闻就是），这个墙上时间
  // 是北京时间，不是 UTC。
  if (!zone) return BEIJING_OFFSET_MS;
  if (zone.toUpperCase() === "Z") return 0;
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60 * 1000;
}

export function parsePublishedAtMs(raw: string): number | null {
  // 博客园的 JSON-LD 把 + 写成了 &#x2B;。script 标签里的实体浏览器不解码，会原样传到这里。
  const text = raw.trim().replace(/&#x2B;|&#43;/gi, "+");
  if (!text) return null;
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{13}$/.test(text)) return Number(text);

  const numeric = text
    .replace(/^(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/u, "$1-$2-$3")
    .replace(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/, "$1-$2-$3");
  const match = numeric.match(NUMERIC_DATE_TIME_PATTERN);
  if (match) {
    const [, year, month, day, hour = "0", minute = "0", second = "0", zone] = match;
    const y = Number(year);
    const mo = Number(month);
    const d = Number(day);
    const h = Number(hour);
    const mi = Number(minute);
    const s = Number(second);
    if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return null;
    const wallClockMs = Date.UTC(y, mo - 1, d, h, mi, s);
    // Date.UTC 会把 2 月 30 日顺延成 3 月 2 日而不报错；日子对不上，说明原串本身不是真日期。
    if (new Date(wallClockMs).getUTCDate() !== d) return null;
    return wallClockMs - zoneOffsetMs(zone);
  }

  // 英文站点偶尔用 RFC 2822（Fri, 11 Sep 2026 06:00:15 GMT）。Date.parse 什么都肯猜，
  // 「Sep 11」会被当成 2001 年，所以只放行同时带四位年份和英文月份的串。
  if (/\b\d{4}\b/.test(text) && /[a-z]{3}/i.test(text)) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// 页面没声明发布时间、或者声明了但解析不了，都返回 null。
export function publishedDateKey(rawPublishedAt: string | undefined): string | null {
  if (!rawPublishedAt) return null;
  const ms = parsePublishedAtMs(rawPublishedAt);
  return ms === null ? null : beijingDateKey(ms);
}

// ---------- 列表页：正文里标给条目的日期 ----------

type DateMarker = { index: number; text: string };

// 写法都取自真实列表页：「2026-09-10 09:42:27」（51CTO）、「2026年9月11日」（starwalk）、
// 「2026年9月10号」（aibase）、「09-08」（国家天文台）、「09月04日 19:07」（雷锋网）、
// 「7小时前」（量子位）。「昨天」「前天」不认；「今日」单独出现也不认，「今日要闻」这类栏目
// 名到处都是。
function todayDateMarkers(text: string, nowMs: number): DateMarker[] {
  const [year, month, day] = beijingDateKey(nowMs).split("-").map(Number);
  const mm = `0?${month}`;
  const dd = `0?${day}`;
  // 日期后面紧跟星期几的是页头时钟，不是条目的日期。
  const notClock = String.raw`(?!\s*[日号]?\s*(?:星期|周)[一二三四五六日天])`;
  const patterns = [
    new RegExp(String.raw`(?<!\d)${year}\s*[-/.年]\s*${mm}\s*[-/.月]\s*${dd}(?!\d)${notClock}`, "gu"),
    // 只有月日时，前面不能紧挨着年份，否则「2025-09-11」里的「09-11」也会被当成今天。
    new RegExp(String.raw`(?<![\d年/.\-])${mm}\s*[-/月]\s*${dd}(?!\d)${notClock}`, "gu"),
    /今天\s*\d{1,2}:\d{2}/gu,
    // 只认单独成词的「刚刚」：新闻标题里「刚刚，OpenAI 发布…」这种写法跟日期无关。
    /(?<!\S)刚刚(?!\S)/gu,
  ];
  const markers: DateMarker[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) markers.push({ index: match.index ?? 0, text: match[0] });
  }
  // 「N小时前」只在 N 小时还没越过今天零点时才算今天。
  const sinceMidnightMs = (nowMs + BEIJING_OFFSET_MS) % DAY_MS;
  for (const match of text.matchAll(/(?<![\d.])(\d{1,3})\s*(分钟|小时)前/gu)) {
    const agoMs = Number(match[1]) * (match[2] === "小时" ? 60 * 60 * 1000 : 60 * 1000);
    if (agoMs <= sinceMidnightMs) markers.push({ index: match.index ?? 0, text: match[0] });
  }
  return markers;
}

export function findTodayDateMarkers(text: string, nowMs: number): string[] {
  return todayDateMarkers(text, nowMs).map((marker) => marker.text);
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

// 证据要逐字出现在那一页上（空白可以不同——模型抄的时候常把空格吞掉或补上），并且它覆盖的
// 那段原文里得有一个今天的标记。标记是在整页上找的，所以前后文照样生效：页头时钟后面的
// 「星期五」、「2025-」后面的「09-11」，都不会因为证据只抄了一截就蒙混过去。
function evidenceShowsToday(evidence: string, pageText: string, nowMs: number): boolean {
  const chars = [...evidence.replace(/\s+/g, "")];
  if (chars.length === 0) return false;
  const markers = todayDateMarkers(pageText, nowMs);
  if (markers.length === 0) return false;
  const pattern = new RegExp(chars.map(escapeRegExpChar).join(String.raw`\s*`), "gu");
  for (const match of pageText.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (markers.some((marker) => marker.index >= start && marker.index + marker.text.length <= end)) return true;
  }
  return false;
}

// ---------- 把两种认法接到播报上 ----------

export type FreshnessPage = {
  url: string;
  excerpt: string;
  publishedAt?: string;
  error?: string;
  links?: ReadonlyArray<{ url: string }>;
};

// article-today：元数据说今天发布，整页可用。
// dated-listing：没有元数据，但正文里写着今天的日期，条目要逐条核对。
export type BroadcastSourceKind = "article-today" | "dated-listing";

export type BroadcastSource<P extends FreshnessPage = FreshnessPage> = { page: P; kind: BroadcastSourceKind };

export type RejectedBroadcastPage = { url: string; reason: string };

export function classifyBroadcastSources<P extends FreshnessPage>(
  pages: readonly P[],
  nowMs: number,
): { sources: BroadcastSource<P>[]; rejected: RejectedBroadcastPage[] } {
  const todayKey = beijingDateKey(nowMs);
  const sources: BroadcastSource<P>[] = [];
  const rejected: RejectedBroadcastPage[] = [];
  for (const page of pages) {
    if (page.error) continue;
    const publishedKey = publishedDateKey(page.publishedAt);
    if (publishedKey === todayKey) {
      sources.push({ page, kind: "article-today" });
    } else if (publishedKey !== null) {
      rejected.push({ url: page.url, reason: `published=${publishedKey}` });
    } else if (todayDateMarkers(page.excerpt, nowMs).length > 0) {
      sources.push({ page, kind: "dated-listing" });
    } else {
      rejected.push({ url: page.url, reason: "no publish date, and no date of today on the page" });
    }
  }
  return { sources, rejected };
}

// 条目的链接是今天的文章页本身，直接放行；来自列表页（页面地址或它的条目链接）的，要拿模型
// 抄来的日期原文去那一页核对。一个链接可能同时出现在几页上，任何一页核对得上就算数。
export function isBroadcastItemFresh(
  item: { url: string; dateEvidence?: string },
  sources: readonly BroadcastSource[],
  nowMs: number,
): boolean {
  return sources.some((source) => {
    if (source.kind === "article-today") return source.page.url === item.url;
    const onThisPage = source.page.url === item.url
      || (source.page.links ?? []).some((link) => link.url === item.url);
    return onThisPage && evidenceShowsToday(item.dateEvidence ?? "", source.page.excerpt, nowMs);
  });
}
