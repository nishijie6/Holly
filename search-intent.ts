export type SearchIntentContextMessage = {
  content: string;
  timestamp?: string | null;
};

export type ExplicitSearchRequest = {
  requested: boolean;
  query: string;
  usedPreviousContext: boolean;
};

// Keep noun uses such as "搜索算法怎么实现" out of the explicit-command path.
// A command must either address Holly, contain an imperative helper/联网 phrase,
// use 一下/看看, or start with a short search verb such as "搜 XXX".
const SEARCH_DIRECTIVE_PATTERNS: readonly RegExp[] = [
  /(?:请|麻烦)?(?:你)?(?:帮我|帮忙|替我|给我)(?:上网|联网|网上)?(?:搜索|搜|查询|查找|查证|查|检索|百度|谷歌)(?:一下|下|一查|一搜|查查|搜搜|看看)?/iu,
  /(?:请|麻烦)?你(?:上网|联网|网上)?(?:搜索|搜|查询|查找|查证|查|检索|百度|谷歌)(?:一下|下|一查|一搜|查查|搜搜|看看)?/iu,
  /(?:上网|联网|网上)(?:搜索|搜|查询|查找|查证|查|检索)(?:一下|下|查查|搜搜|看看)?/iu,
  /(?:搜索|搜|查询|查找|查证|查|检索|百度|谷歌)(?:一下|一查|一搜|查查|搜搜|看看)/iu,
  /^(?:请|麻烦)?(?:搜索|查询|查找|查证|检索|百度|谷歌)(?:一下|下|查查|搜搜|看看)?(?=\s|[：:])/iu,
  /^(?:请|麻烦)?(?:搜(?!索)|查(?!询|找|证))(?:一下|下|查查|搜搜|看看)?(?=\s|[：:]|[\p{L}\p{N}])/iu,
  /\b(?:please\s+)?(?:search(?:\s+the\s+web)?(?:\s+for)?|look\s+(?:it|this|that)\s+up|google(?:\s+(?:it|this|that))?)\b/iu,
];

const GENERIC_QUERY = /^(?:这|那|它|这个|那个|这个事|那个事|这事|那事|这件事|那件事|刚才那个|上面那个|前面那个|消息|新闻)$/u;

function normalizeConversationText(value: string): string {
  return value
    .replace(/\[CQ:[^\]]+\]/giu, " ")
    .replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+(?:群聊\s*\[[^\]]+\]\s*\[[^\]]+\]|私聊\s*\[[^\]]+\])\s*/u, "")
    .replace(/^(?:群聊\s*\[[^\]]+\]\s*\[[^\]]+\]|私聊\s*\[[^\]]+\])\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function findSearchDirective(text: string): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const pattern of SEARCH_DIRECTIVE_PATTERNS) {
    const match = pattern.exec(text);
    if (typeof match?.index !== "number" || !match[0]) continue;
    const candidate = { index: match.index, length: match[0].length };
    if (
      best === null
      || candidate.index < best.index
      || (candidate.index === best.index && candidate.length > best.length)
    ) {
      best = candidate;
    }
  }
  return best;
}

function cleanQuery(value: string): string {
  return value
    .replace(/^(?:@?holly|霍莉|holly酱)\s*[，,:：]?\s*/iu, "")
    .replace(/\s*(?:可以吗|行吗|好吗|谢谢|谢了)\s*[。！？!?]*$/u, "")
    .replace(/^[，,:：。！？!?；;\s]+|[，,:：。！？!?；;\s]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

function queryWithoutDirective(text: string, directive: { index: number; length: number }): string {
  return cleanQuery(`${text.slice(0, directive.index)} ${text.slice(directive.index + directive.length)}`);
}

function isUsableQuery(value: string): boolean {
  return value.length >= 2 && !GENERIC_QUERY.test(value);
}

function parseTime(value: string | number | Date | null | undefined): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function formatShanghaiDate(referenceMs: number, dayOffset: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(referenceMs));
  const readPart = (type: Intl.DateTimeFormatPartTypes): number => (
    Number(parts.find((part) => part.type === type)?.value ?? "0")
  );
  const shifted = new Date(Date.UTC(
    readPart("year"),
    readPart("month") - 1,
    readPart("day") + dayOffset,
  ));
  return `${shifted.getUTCFullYear()}年${shifted.getUTCMonth() + 1}月${shifted.getUTCDate()}日`;
}

export function normalizeSearchQuery(
  value: string,
  referenceTime?: string | number | Date | null,
): string {
  const referenceMs = parseTime(referenceTime);
  let query = cleanQuery(value)
    .replace(/[，,]\s*(?:你)?(?:知道|听说|了解)(?:这件事|这事|吗|不)?[？?。！!]*$/u, "")
    .trim();

  if (referenceMs !== null) {
    query = query
      .replace(/大前天/gu, `${formatShanghaiDate(referenceMs, -3)} `)
      .replace(/前天/gu, `${formatShanghaiDate(referenceMs, -2)} `)
      .replace(/昨天/gu, `${formatShanghaiDate(referenceMs, -1)} `)
      .replace(/今天/gu, `${formatShanghaiDate(referenceMs, 0)} `);
  }

  // Vague obituary phrasing is conversationally natural but a poor search
  // query. Keep the date and event, drop non-identifying filler, and ask the
  // engine for news; named people remain untouched.
  if (/(?:去世|逝世|病逝|死亡)/u.test(query)) {
    query = query
      .replace(/(?:听说|好像|据说|有个|一个)/gu, " ")
      .replace(/(?:大人物|重要人物|名人)/gu, " ")
      .replace(/[的了](?=\s|$)/gu, " ");
    if (!/(?:新闻|讣告)/u.test(query)) query = `${query} 新闻`;

    const datedEvent = query.match(/\d{4}年\d{1,2}月\d{1,2}日/u)?.[0] ?? "";
    const remainingTerms = query
      .replace(datedEvent, " ")
      .replace(/(?:去世|逝世|病逝|死亡|新闻|讣告)/gu, " ")
      .replace(/\s+/gu, "")
      .trim();
    if (datedEvent && !remainingTerms) {
      return `"${datedEvent}" 逝世`;
    }
  }

  return cleanQuery(query.replace(/[，,。！？!?；;：:]+/gu, " "));
}

export function resolveExplicitSearchRequest(input: {
  message: string;
  context?: readonly SearchIntentContextMessage[];
  referenceTime?: string | number | Date | null;
}): ExplicitSearchRequest {
  const current = normalizeConversationText(input.message);
  const directive = findSearchDirective(current);
  if (!directive) {
    return { requested: false, query: "", usedPreviousContext: false };
  }

  const referenceMs = parseTime(input.referenceTime);
  const directQuery = normalizeSearchQuery(queryWithoutDirective(current, directive), referenceMs);
  if (isUsableQuery(directQuery)) {
    return { requested: true, query: directQuery, usedPreviousContext: false };
  }

  const context = input.context ?? [];
  let skippedCurrent = false;

  for (let index = context.length - 1; index >= 0; index -= 1) {
    const item = context[index];
    const content = normalizeConversationText(item.content);
    if (!content) continue;

    // The focused timeline includes the current message itself. Skip its most
    // recent occurrence before looking for the topic immediately above it.
    if (!skippedCurrent && content === current) {
      skippedCurrent = true;
      continue;
    }

    const previousDirective = findSearchDirective(content);
    const rawCandidate = previousDirective
      ? queryWithoutDirective(content, previousDirective)
      : cleanQuery(content);
    // Resolve relative dates against the original topic turn, not against the
    // later follow-up. Conversation adjacency decides relevance; elapsed wall
    // time does not.
    const candidateReferenceTime = parseTime(item.timestamp) ?? referenceMs;
    const candidate = normalizeSearchQuery(rawCandidate, candidateReferenceTime);
    if (isUsableQuery(candidate)) {
      return { requested: true, query: candidate, usedPreviousContext: true };
    }
  }

  return { requested: true, query: "", usedPreviousContext: false };
}
