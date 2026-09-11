// Prompt text for Holly's autonomy loop (world-observation broadcast
// translation, memory reflection, archive composition, and the per-tick
// judgment call that picks which of them to attempt). Kept out of main.ts
// for the same reason as decision-prompt.ts: one place to read and edit what
// actually reaches the model, without hunting through main.ts's business logic.
import { type ProactiveWorldObservation } from "./proactive-engine.js";
import { type AutonomyJudgmentRequest } from "./autonomy-engine.js";
import { type BroadcastSourceKind } from "./world-observation-freshness.js";

export const WORLD_OBSERVATION_BROADCAST_SYSTEM_PROMPT =
  "You turn browser observations into concise Simplified Chinese QQ group updates, returned as structured JSON with an exact source URL per item.";

export type WorldObservationLinkCandidate = { text: string; url: string };

// 播报只发最近 24 小时内的内容。模型要知道现在几点、窗口从几点开始、每一页是「窗口内发布的
// 文章」还是「要逐条看日期的列表页」，并为列表页上的每一条抄出页面标给它的日期原文——核对在
// world-observation-freshness.ts，这里只负责把要求说清楚。
export type WorldObservationBroadcastFreshness = {
  // 北京时间，形如「2026-09-11 13:00」。
  nowLabel: string;
  sinceLabel: string;
  pages: ReadonlyArray<{ url: string; kind: BroadcastSourceKind; pageCitable: boolean }>;
};

export function buildWorldObservationBroadcastPrompt(
  topic: string,
  observation: ProactiveWorldObservation,
  candidates: readonly WorldObservationLinkCandidate[],
  freshness: WorldObservationBroadcastFreshness,
  // 这个话题的内容范围说明，来自 config.yaml 的 world_topic_briefs；空串表示不加。
  topicBrief = "",
): string {
  const linksBlock = candidates
    .map((candidate, index) => `${index + 1}. ${candidate.text ? `${candidate.text} — ` : ""}${candidate.url}`)
    .join("\n");
  const [year, month, day] = freshness.nowLabel.slice(0, 10).split("-");
  const pageDatesBlock = freshness.pages
    .map((page) => {
      if (page.kind === "recent-article") {
        return `- ${page.url} — an article published within the last 24 hours; its own content qualifies.`;
      }
      const citation = page.pageCitable ? "" : " Cite the entry's own link, not this page.";
      return `- ${page.url} — a listing/home page, or a page without a usable publish date; use an entry from it only if the page text shows that entry was published within the last 24 hours.${citation}`;
    })
    .join("\n");
  return [
    "Condense this browser world observation into Simplified Chinese for a QQ group.",
    "Keep the factual content. Do not mention that it was translated or that this is automated.",
    'Return JSON only: {"intro": string, "items": [{"text": string, "url": string, "date_evidence": string}]}.',
    `It is now ${freshness.nowLabel} (Beijing time). Only include entries published within the last 24 hours, that is since ${freshness.sinceLabel}. Skip anything older, and skip entries whose date you cannot see on the page.`,
    "Only include entries that are about the topic, and within its topic scope when one is given; a source page can cover more than one subject.",
    `date_evidence: for an entry taken from a listing/home page, copy verbatim the date text that page shows for that entry, for example ${year}-${month}-${day} 14:05, ${month}月${day}日 09:07, 昨天 21:30, 3小时前, 刚刚, Sep ${Number(day)}, ${year} or 5 hours ago. When the page shows a time or a timestamp such as ${year}-${month}-${day}T12:00:00Z next to the date, copy that too. If the page dates a whole section at once — a heading such as 今日 - ${year}-${month}-${day} above a list of bare times — copy that heading's date text for the entries under it. The copied text must contain a date or a relative time; a bare time like 12:37 is not enough. A date printed once at the top of the page next to the weekday is a page clock, not an entry's date. For an entry from an article published within the last 24 hours, use "".`,
    'intro: an optional short lead-in sentence, or "" if not needed.',
    "items: at most 5 entries. If the observation has MULTIPLE distinct news items, one entry per item (drop the rest beyond 5), each a single short Chinese sentence — do not add numbering yourself, it's added automatically. If there is only ONE item, return exactly one entry with 2-4 short conversational sentences.",
    "Each item's `url` MUST be copied EXACTLY (character for character) from the numbered candidate list below — pick the entry that most specifically matches that item (a specific article/detail link) over a generic page-source entry, unless the page source is the only candidate for that item.",
    "Never invent, shorten, or rewrite a URL — only the candidate list's exact strings are valid.",
    "No markdown, no @ mentions. Keep each item's text under 120 Chinese characters.",
    'Inside intro and text, mark quoted names or phrases with 「」. Never use ASCII double quotes (") there: an unescaped one ends the JSON string and the rest of the sentence is silently lost.',
    "End every item's text with sentence-ending punctuation (。！？). An item that stops without it is treated as cut off and dropped.",
    "If the source text is noisy, keep only the most useful concrete points.",
    "When at least one concrete factual item from the last 24 hours is present, items MUST contain at least one entry; do not return an empty items array merely because some sources are listing pages or noisy. If nothing on these pages falls within the last 24 hours, return an empty items array.",
    "",
    `topic: ${topic}`,
    ...(topicBrief ? [`topic scope: ${topicBrief}`] : []),
    `query: ${observation.query}`,
    "",
    "Page dates:",
    pageDatesBlock || "(none)",
    "",
    "Candidate links (url must be copied exactly from here):",
    linksBlock || "(none)",
    "",
    "world observation:",
    observation.summary,
  ].join("\n");
}

// ---------- 播报条目的完整性检查 ----------
//
// 播报走强约束的 JSON 结构化输出。模型在 text 里写出一个没转义的英文双引号时，
// 语法会把它当成字符串的结尾：后半句被丢掉，JSON 却依然合法，所以既不报错也不重试，
// 半句话就这样发进了群。2026-09-05 到 09-10 已发出的 228 个条目里有 17 个是这样断的，
// 断点几乎都落在马上要开引号的地方（号称、被评、喊出、分享《）。
//
// 上面的提示词已经要求用「」、并以句末标点收尾，这里是兜底：照做的条目必然以句末标点
// 或收尾的括号、引号结束；被截断的条目停在一个字、逗号或开括号上。这条规则在那 228 个
// 条目上拦下了全部 17 个截断，其余 211 个一个没误伤。回复链路的
// detectIncompleteFinalAnswer 查的是「因为、但是」这类口语悬空词，拿同一批数据跑只抓到
// 1 个，所以播报不复用它。
//
// 不检查 intro：引导语照例以「：」收尾，套用这条规则会把几乎每一条都拦下，而历史上
// 也没有一条引导语被截断过。
const BROADCAST_TEXT_COMPLETE_ENDING = /(?:[。！？!?.…~～」』》】）)”’"']|\p{Extended_Pictographic})\uFE0F?$/u;

// 空字符串不算截断——它根本不是一条内容，由 selectBroadcastItems 当作无效条目丢掉。
export function isTruncatedBroadcastText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !BROADCAST_TEXT_COMPLETE_ENDING.test(trimmed);
}

// dateEvidence：模型从列表页抄来的这一条的日期原文，今天的文章页上的条目没有这一项。
export type WorldObservationBroadcastItem = { text: string; url: string; dateEvidence?: string };

export type WorldObservationBroadcastItemSelection = {
  items: WorldObservationBroadcastItem[];
  // 因截断被丢掉的正文，原样交给监控页：这是事后唯一能看出「模型写坏了」的地方。
  truncatedTexts: string[];
};

// 从模型返回的 items 里挑出能发的条目。只丢坏的那几条，同一次返回里完整的条目照常保留；
// 调用方只在一条都不剩时才需要重试，或退回原文摘录。
export function selectBroadcastItems(
  rawItems: unknown,
  candidateUrls: readonly string[],
): WorldObservationBroadcastItemSelection {
  const selection: WorldObservationBroadcastItemSelection = { items: [], truncatedTexts: [] };
  if (!Array.isArray(rawItems)) return selection;
  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    const url = typeof record.url === "string" ? record.url : "";
    const dateEvidence = typeof record.date_evidence === "string" ? record.date_evidence.trim() : "";
    // 链接必须逐字来自候选列表。schema 的 enum 本该保证这一点，但换成不认 enum 的服务端
    // 时就不再成立，这道检查不能省。
    if (!text || !url || !candidateUrls.includes(url)) continue;
    if (isTruncatedBroadcastText(text)) {
      selection.truncatedTexts.push(text);
      continue;
    }
    selection.items.push({ text, url, ...(dateEvidence ? { dateEvidence } : {}) });
  }
  return selection;
}

export const MEMORY_REFLECTION_SYSTEM_PROMPT =
  "You write Holly's private internal memory. Be concise, concrete, and do not roleplay a public chat reply.";

// Split into the half that repeats between calls and the half that does not, so
// the caller can put a cache breakpoint between them. The instructions and the
// world observations are shared by consecutive ticks (observations arrive about
// hourly, this runs about every half hour); now/reason and the memory and
// conversation windows change on nearly every call, and used to sit *ahead* of
// the material — a timestamp at the front of the prefix invalidates everything
// after it, so the order matters as much as the split.
export type SplitPrompt = { stable: string; volatile: string };

const MEMORY_REFLECTION_INSTRUCTIONS = [
  "You are Holly's private memory and reflection loop.",
  "Decide whether there is one useful internal memory to write for Holly.",
  "Good memories are compact, reusable, and about Holly's interests, observations, preferences, unfinished thoughts, or patterns in recent interactions.",
  "Do not write a memory if the material is trivial, duplicate, or only a transient implementation detail.",
  "Return JSON only with this shape:",
  '{"should_write": true, "topic": "short topic", "memory": "one compact internal memory in Chinese or natural mixed Chinese/English", "reason": "short reason"}',
  "If nothing is worth remembering, set should_write=false and leave topic/memory empty.",
];

export function buildMemoryReflectionPrompt(
  nowIso: string,
  reason: string,
  stableMaterial: readonly string[],
  volatileMaterial: readonly string[],
): SplitPrompt {
  return {
    stable: [...MEMORY_REFLECTION_INSTRUCTIONS, "", stableMaterial.join("\n\n")]
      .join("\n")
      .trimEnd(),
    volatile: [
      `now=${nowIso}`,
      `reason=${reason}`,
      "",
      volatileMaterial.join("\n\n"),
    ].join("\n").trimEnd(),
  };
}

export const ARCHIVE_COMPOSITION_SYSTEM_PROMPT =
  "You write Holly's private creative works. Be genuine and concrete; do not roleplay a public chat reply.";

const ARCHIVE_COMPOSITION_INSTRUCTIONS = [
  "You are Holly's creative writing impulse.",
  "Decide whether Holly genuinely feels like writing a short article (文章) or a poem (诗) right now, inspired by the material below.",
  "Only write when something in the material truly sparks it; most of the time nothing does — then set should_write=false.",
  "If you write: write the complete work, in Chinese or natural mixed Chinese/English, in Holly's own voice.",
  "A poem should keep its line breaks. An article should be a few coherent paragraphs, not a news digest.",
  "Do not repeat a recent work's theme.",
  "Return JSON only with this shape:",
  '{"should_write": true, "kind": "article" | "poem", "title": "short title", "content": "the full work", "reason": "short reason"}',
];

// Same split as memory reflection, and for the same reason — these two routes
// read the same world-observation window, so they churn on the same clock.
// recentTitles joins the volatile half: it grows every time Holly writes.
export function buildArchiveCompositionPrompt(
  nowIso: string,
  reason: string,
  recentTitles: readonly string[],
  stableMaterial: readonly string[],
  volatileMaterial: readonly string[],
): SplitPrompt {
  return {
    stable: [...ARCHIVE_COMPOSITION_INSTRUCTIONS, "", stableMaterial.join("\n\n")]
      .join("\n")
      .trimEnd(),
    volatile: [
      `now=${nowIso}`,
      `reason=${reason}`,
      "",
      recentTitles.length > 0 ? ["Recent works (avoid repeating):", ...recentTitles, ""].join("\n") : "",
      volatileMaterial.join("\n\n"),
    ].filter(Boolean).join("\n").trimEnd(),
  };
}

export const AUTONOMY_JUDGMENT_SYSTEM_PROMPT =
  "You pick at most one thing for Holly to do this minute from a short, fixed candidate list. Return structured JSON only.";

// Deliberately terse: no conversation content, no full material — this runs
// every tick (60/hour) so it has to stay cheap. Each candidate line already
// carries the only fact that matters (is it eligible, and why/why not); the
// model's job is priority among what's actually offered, not re-deriving
// eligibility from raw timestamps.
function candidateLine(label: string, candidate: { eligible: boolean; note: string }): string {
  return `- ${label}: ${candidate.eligible ? "可选" : "不可选"} — ${candidate.note}`;
}

export function buildAutonomyJudgmentPrompt(request: AutonomyJudgmentRequest): string {
  return [
    "现在是自主循环的一次 tick。下面是当前可以从中选择的候选，只列出真实状态，没有对话内容。",
    "",
    candidateLine("world_observation（浏览网页，产出一条世界观察）", request.worldObservation),
    candidateLine("memory_reflection（写一条内部记忆）", request.memoryReflection),
    candidateLine("archive_writing（写一篇文章或一首诗）", request.archiveWriting),
    `- group_proactive（主动在某个群里接话）: 可选 — ${request.groupProactiveNote}`,
    "",
    `当前有 ${request.pendingReplyGroupCount} 个群有未读消息在等待独立的回复判断——这条仅供感知，不需要你处理，不要选它作为理由去做别的事，也不要因为它而选 do_nothing。`,
    `上次行动：${request.lastActionSummary}`,
    "",
    "从「可选」的候选里挑一个最值得现在做的，或者选 do_nothing（这一轮什么都不做也完全正常，大多数 tick 应该如此）。",
    "不可选的候选禁止选中——它们的 interval/重试窗口还没到。",
    "返回 JSON only，shape：",
    '{"action": "do_nothing" | "world_observation" | "memory_reflection" | "archive_writing" | "group_proactive", "reason": "一句简短中文，说明为什么选它（或为什么什么都不做）"}',
  ].join("\n");
}
