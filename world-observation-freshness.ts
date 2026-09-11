// 世界观察播报「只发最近 24 小时内的内容」的判断。
//
// 播报原先只靠去重挡重复：比链接、比文字相似度、回看七天。挡不住的是旧内容换个地址再出现——
// 91maths 的「换一批」列表页每次地址都不同，同一道「8 个 8 组成 1000」于是在 9 月发了八次；
// 博客园 2021 年的数学知识合集、腾讯新闻 8 月 2 日的旧稿，也都被当成「最新进展」播过。所以换
// 个角度卡：只发最近 24 小时内发布的内容。
//
// 窗口起初是「北京时间的今天」，按日历切：零点一过，列表页上还没有当天的条目，凌晨到早上几乎
// 发不出东西。现在是往回数 24 小时的滑动窗口，凌晨也接得上前一晚的新闻。
//
// 页面分两种认法。像文章的页面看元数据（article:published_time 一类的 meta、JSON-LD 的
// datePublished，由 browser-agent.ts 读出原始字符串）：在窗口内，整页可用；不在，整页不要。
// 列表页、首页和没有可用元数据的页面，只在正文里确实写着窗口内的日期时才交给模型，并要求模型
// 为每一条抄出页面上标给它的日期原文，这里逐条核对：原文得真在那一页上，而且落在窗口内。
//
// 「像文章」不能只看有没有元数据。36氪 AI 频道是个列表页，渲染后却带着一个今天的
// article:published_time——前端脚本写进去的，跟底下哪一条的发布时间都无关；NASA 新闻列表页
// 挂着全站通用的 2022 年元数据。所以正文里出现三处以上日期的页面一律按列表页处理，元数据只拿来
// 决定这一页自己的地址能不能被引用。
//
// 列表页这一路比元数据弱：模型可能把别处的日期安到一条旧新闻头上。压低这种错的是三条规矩：
// 证据必须逐字出现在同一页；页头常驻的「2026年9月11日 星期五」这种时钟不算数——上海天文台
// 首页就挂着一个，底下的新闻却是 9 月 7 日的；日期后面紧跟着时间的，证据必须连时间一起抄，
// 免得「09-10」替「09-10 09:00」这种已经出了窗口的条目蒙混过关。

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// 往回数多久算「最近」。
export const FRESHNESS_WINDOW_MS = 24 * HOUR_MS;

// 页面上的时间允许比现在略晚一点：36氪一篇文章的 published_time 比 Holly 发出播报还晚了几十秒，
// 不带时区的时间按北京时间解析时也可能错开。再往后的「未来时间」就不可信了。
const FUTURE_TOLERANCE_MS = 2 * HOUR_MS;

// 正文里有这么多处日期，就按列表页处理，元数据不再替整页作保。
const LISTING_DATE_TOKEN_MIN = 3;

// 群在国内，日子按北京时间切。中国不用夏令时，固定加 8 小时就够，不依赖运行环境的 TZ 和
// ICU 数据，测试机和线上机器时区不同时结果也一样。
export function beijingDateKey(ms: number): string {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function beijingDateTimeLabel(ms: number): string {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
}

// 给提示词和监控看的窗口描述，北京时间，形如「2026-09-11 13:00」。
export function freshnessWindowLabels(nowMs: number): { now: string; since: string } {
  return { now: beijingDateTimeLabel(nowMs), since: beijingDateTimeLabel(nowMs - FRESHNESS_WINDOW_MS) };
}

// ---------- 发布时间的解析 ----------

function zoneOffsetMs(zone: string | undefined): number {
  // 国内站点的 meta 经常只写「2026-08-02 17:00:59」不带时区（腾讯新闻就是），这个墙上时间
  // 是北京时间，不是 UTC。
  if (!zone) return BEIJING_OFFSET_MS;
  if (zone.toUpperCase() === "Z") return 0;
  const sign = zone.startsWith("-") ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * MINUTE_MS;
}

function wallClockToMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string | undefined,
): number | null {
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const wallClockMs = Date.UTC(year, month - 1, day, hour, minute, second);
  // Date.UTC 会把 2 月 30 日顺延成 3 月 2 日而不报错；日子对不上，说明原串本身不是真日期。
  if (new Date(wallClockMs).getUTCDate() !== day) return null;
  return wallClockMs - zoneOffsetMs(zone);
}

const NUMERIC_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

// hasTime=false 表示只知道是哪一天，ms 落在那天北京时间零点。
export type PublishedAt = { ms: number; hasTime: boolean };

export function parsePublishedAt(raw: string): PublishedAt | null {
  // 博客园的 JSON-LD 把 + 写成了 &#x2B;。script 标签里的实体浏览器不解码，会原样传到这里。
  const text = raw.trim().replace(/&#x2B;|&#43;/gi, "+");
  if (!text) return null;
  if (/^\d{10}$/.test(text)) return { ms: Number(text) * 1000, hasTime: true };
  if (/^\d{13}$/.test(text)) return { ms: Number(text), hasTime: true };

  const numeric = text
    .replace(/^(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/u, "$1-$2-$3")
    .replace(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/, "$1-$2-$3");
  const match = numeric.match(NUMERIC_DATE_TIME_PATTERN);
  if (match) {
    const [, year, month, day, hour, minute, second, zone] = match;
    const hasTime = typeof hour === "string";
    const ms = wallClockToMs(
      Number(year),
      Number(month),
      Number(day),
      hasTime ? Number(hour) : 0,
      hasTime ? Number(minute) : 0,
      typeof second === "string" ? Number(second) : 0,
      zone,
    );
    return ms === null ? null : { ms, hasTime };
  }

  // 英文站点偶尔用 RFC 2822（Fri, 11 Sep 2026 06:00:15 GMT）。Date.parse 什么都肯猜，
  // 「Sep 11」会被当成 2001 年，所以只放行同时带四位年份和英文月份的串。
  if (/\b\d{4}\b/.test(text) && /[a-z]{3}/i.test(text)) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? { ms: parsed, hasTime: /\d{1,2}:\d{2}/.test(text) } : null;
  }
  return null;
}

function isWithinWindow(published: PublishedAt, nowMs: number): boolean {
  if (published.hasTime) {
    return published.ms >= nowMs - FRESHNESS_WINDOW_MS && published.ms <= nowMs + FUTURE_TOLERANCE_MS;
  }
  // 只知道是哪一天时，这一天和窗口有重叠就算——24 小时窗口能碰到的只有今天和昨天。
  const dateKey = beijingDateKey(published.ms);
  return dateKey === beijingDateKey(nowMs) || dateKey === beijingDateKey(nowMs - DAY_MS);
}

// ---------- 正文里的日期 ----------

type DateMarker = { index: number; text: string };

const MONTH_NAMES: readonly (readonly string[])[] = [
  ["January", "Jan"],
  ["February", "Feb"],
  ["March", "Mar"],
  ["April", "Apr"],
  ["May"],
  ["June", "Jun"],
  ["July", "Jul"],
  ["August", "Aug"],
  ["September", "Sept", "Sep"],
  ["October", "Oct"],
  ["November", "Nov"],
  ["December", "Dec"],
];

// 日期后面紧跟星期几的是页头时钟，不是条目的日期。英文页面把星期写在前面。
const CHINESE_CLOCK_AHEAD = String.raw`(?!\s*[日号]?\s*(?:星期|周)[一二三四五六日天])`;
const ENGLISH_CLOCK_BEHIND = String.raw`(?<!(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s{0,3})`;

// 紧跟在日期后面的时间：「09月11日 19:07」「2026-09-10 09:42:27」「2026-09-10T20:00:00Z」。
// 时区前的空白只在真有时区时才吃进来，否则标记会带上尾随空格，比模型抄的证据长出一截；
// Z 后面不能紧跟字母，免得「10:30 Zhang」被当成 UTC 时间，平白错开 8 小时。
const TRAILING_TIME_PATTERN = /^\s*(?:[T日号]\s*)?(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:\s*(Z(?![A-Za-z])|[+-]\d{2}:?\d{2}))?/;

// 写法都取自真实列表页：「2026-09-10 09:42:27」（51CTO）、「2026年9月11日」（starwalk）、
// 「2026年9月10号」（aibase）、「09-08」（国家天文台）、「09月04日 19:07」「昨天 15:00」（雷锋网）、
// 「7小时前」（量子位）、「Sep 9, 2026」「11 hours ago」（phys.org）、「Sept. 10, 2026」
// （Space.com）、「September 10, 2026」（Quanta）。「今日」「昨天」「today」单独出现不认：
// 「今日要闻」这类栏目名、「昨天发布的模型」这类正文到处都是。
function recentDateMarkers(text: string, nowMs: number): DateMarker[] {
  const markers: DateMarker[] = [];
  const inWindow = (ms: number): boolean => ms >= nowMs - FRESHNESS_WINDOW_MS && ms <= nowMs + FUTURE_TOLERANCE_MS;

  for (const dayMs of [nowMs, nowMs - DAY_MS]) {
    const [year, month, day] = beijingDateKey(dayMs).split("-").map(Number);
    const mm = `0?${month}`;
    const dd = `0?${day}`;
    const numericPatterns = [
      new RegExp(String.raw`(?<!\d)${year}\s*[-/.年]\s*${mm}\s*[-/.月]\s*${dd}(?!\d)${CHINESE_CLOCK_AHEAD}`, "gu"),
      // 只有月日时，前面不能紧挨着年份，否则「2025-09-11」里的「09-11」也会被当成今天。
      new RegExp(String.raw`(?<![\d年/.\-])${mm}\s*[-/月]\s*${dd}(?!\d)${CHINESE_CLOCK_AHEAD}`, "gu"),
    ];
    for (const pattern of numericPatterns) {
      for (const match of text.matchAll(pattern)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        const time = text.slice(end, end + 32).match(TRAILING_TIME_PATTERN);
        if (!time) {
          markers.push({ index: start, text: match[0] });
          continue;
        }
        // 日期后面跟着时间，就按时间判，标记也连时间一起算——证据得把时间抄全。
        const ms = wallClockToMs(year, month, day, Number(time[1]), Number(time[2]), Number(time[3] ?? 0), time[4]);
        if (ms !== null && inWindow(ms)) markers.push({ index: start, text: text.slice(start, end + time[0].length) });
      }
    }
    const names = MONTH_NAMES[month - 1].join("|");
    const englishPatterns = [
      new RegExp(String.raw`${ENGLISH_CLOCK_BEHIND}\b(?:${names})\.?\s+0?${day},?\s+${year}\b`, "giu"),
      new RegExp(String.raw`${ENGLISH_CLOCK_BEHIND}\b0?${day}\s+(?:${names})\.?,?\s+${year}\b`, "giu"),
    ];
    for (const pattern of englishPatterns) {
      for (const match of text.matchAll(pattern)) markers.push({ index: match.index ?? 0, text: match[0] });
    }
  }

  const today = beijingDateKey(nowMs).split("-").map(Number);
  const yesterday = beijingDateKey(nowMs - DAY_MS).split("-").map(Number);
  for (const match of text.matchAll(/(今天|昨天)\s*(\d{1,2}):(\d{2})/gu)) {
    const [year, month, day] = match[1] === "今天" ? today : yesterday;
    const ms = wallClockToMs(year, month, day, Number(match[2]), Number(match[3]), 0, undefined);
    if (ms !== null && inWindow(ms)) markers.push({ index: match.index ?? 0, text: match[0] });
  }
  // 只认单独成词的「刚刚」「just now」：新闻标题里「刚刚，OpenAI 发布…」这种写法跟日期无关。
  for (const match of text.matchAll(/(?<!\S)(?:刚刚|just now)(?!\S)/giu)) {
    markers.push({ index: match.index ?? 0, text: match[0] });
  }
  for (const match of text.matchAll(/(?<![\d.])(\d{1,4})\s*(分钟|小时)前/gu)) {
    const agoMs = Number(match[1]) * (match[2] === "小时" ? HOUR_MS : MINUTE_MS);
    if (agoMs <= FRESHNESS_WINDOW_MS) markers.push({ index: match.index ?? 0, text: match[0] });
  }
  for (const match of text.matchAll(/\b(\d{1,4}|an?|one)\s+(minutes?|mins?|hours?|hrs?)\s+ago\b/giu)) {
    const count = /^\d/.test(match[1]) ? Number(match[1]) : 1;
    const agoMs = count * (/^h/i.test(match[2]) ? HOUR_MS : MINUTE_MS);
    if (agoMs <= FRESHNESS_WINDOW_MS) markers.push({ index: match.index ?? 0, text: match[0] });
  }
  return markers;
}

export function findRecentDateMarkers(text: string, nowMs: number): string[] {
  return recentDateMarkers(text, nowMs).map((marker) => marker.text);
}

// 不管新旧，正文里一共出现了几处日期。只用来判断「这一页是不是列表」。
const ANY_DATE_TOKEN_PATTERNS: readonly RegExp[] = [
  /(?<!\d)20\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}(?!\d)/gu,
  /(?<![\d年])\d{1,2}月\d{1,2}[日号]/gu,
  /(?<![\d.\-/:])(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?![\d\-:])/gu,
  /(?<![\d.])\d{1,4}\s*(?:分钟|小时|天)前|(?:今天|昨天|前天)\s*\d{1,2}:\d{2}|(?<!\S)刚刚(?!\S)/gu,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+20\d{2}\b/giu,
  /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+20\d{2}\b/giu,
  /\b(?:\d{1,4}|an?)\s+(?:minutes?|mins?|hours?|hrs?|days?)\s+ago\b/giu,
];

function countDateTokens(text: string): number {
  const starts = new Set<number>();
  for (const pattern of ANY_DATE_TOKEN_PATTERNS) {
    for (const match of text.matchAll(pattern)) starts.add(match.index ?? 0);
  }
  return starts.size;
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

// 证据要逐字出现在那一页上（空白可以不同——模型抄的时候常把空格吞掉或补上），并且它覆盖的
// 那段原文里得有一个窗口内的日期标记。标记是在整页上找的，所以前后文照样生效：页头时钟后面的
// 「星期五」、「2025-」后面的「09-11」、日期后面已经出了窗口的时间，都不会因为证据只抄了一截
// 就蒙混过去。
function evidenceShowsRecent(evidence: string, pageText: string, nowMs: number): boolean {
  const chars = [...evidence.replace(/\s+/g, "")];
  if (chars.length === 0) return false;
  const markers = recentDateMarkers(pageText, nowMs);
  if (markers.length === 0) return false;
  const pattern = new RegExp(chars.map(escapeRegExpChar).join(String.raw`\s*`), "giu");
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

// recent-article：像文章的页面，元数据说它在窗口内发布，整页可用。
// dated-listing：列表页，或没有可用元数据的页面，正文里写着窗口内的日期，条目要逐条核对。
export type BroadcastSourceKind = "recent-article" | "dated-listing";

export type BroadcastSource<P extends FreshnessPage = FreshnessPage> = {
  page: P;
  kind: BroadcastSourceKind;
  // 这一页自己的地址能不能被条目引用。元数据说它是旧页面的，只能引用它列出的条目链接。
  pageCitable: boolean;
};

export type RejectedBroadcastPage = { url: string; reason: string };

export function classifyBroadcastSources<P extends FreshnessPage>(
  pages: readonly P[],
  nowMs: number,
): { sources: BroadcastSource<P>[]; rejected: RejectedBroadcastPage[] } {
  const sources: BroadcastSource<P>[] = [];
  const rejected: RejectedBroadcastPage[] = [];
  for (const page of pages) {
    if (page.error) continue;
    const published = page.publishedAt ? parsePublishedAt(page.publishedAt) : null;
    const publishedRecently = published !== null && isWithinWindow(published, nowMs);
    const looksLikeListing = countDateTokens(page.excerpt) >= LISTING_DATE_TOKEN_MIN;
    if (published && !looksLikeListing) {
      if (publishedRecently) sources.push({ page, kind: "recent-article", pageCitable: true });
      else rejected.push({ url: page.url, reason: `published=${beijingDateKey(published.ms)}` });
    } else if (recentDateMarkers(page.excerpt, nowMs).length > 0) {
      sources.push({ page, kind: "dated-listing", pageCitable: published === null || publishedRecently });
    } else {
      rejected.push({
        url: page.url,
        reason: published
          ? `listing with no entry from the last 24 hours (published=${beijingDateKey(published.ms)})`
          : "no publish date, and no date from the last 24 hours on the page",
      });
    }
  }
  return { sources, rejected };
}

// 条目的链接是窗口内的文章页本身，直接放行；来自列表页的（它的条目链接，或者允许引用时它自己
// 的地址），要拿模型抄来的日期原文去那一页核对。一个链接可能同时出现在几页上，任何一页核对
// 得上就算数。
export function isBroadcastItemFresh(
  item: { url: string; dateEvidence?: string },
  sources: readonly BroadcastSource[],
  nowMs: number,
): boolean {
  return sources.some((source) => {
    if (source.kind === "recent-article") return source.page.url === item.url;
    const onThisPage = (source.pageCitable && source.page.url === item.url)
      || (source.page.links ?? []).some((link) => link.url === item.url);
    return onThisPage && evidenceShowsRecent(item.dateEvidence ?? "", source.page.excerpt, nowMs);
  });
}
