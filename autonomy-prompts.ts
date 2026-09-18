// Prompt text for Holly's autonomy loop (world-observation broadcast
// translation, memory reflection, archive composition, and the per-tick
// judgment call that picks which of them to attempt). Kept out of main.ts
// for the same reason as decision-prompt.ts: one place to read and edit what
// actually reaches the model, without hunting through main.ts's business logic.
import { type ProactiveWorldObservation } from "./proactive-engine.js";
import { type AutonomyJudgmentRequest, type RecentAutonomyAction, type WorldTopicStatus } from "./autonomy-engine.js";
import { type BroadcastSourceKind } from "./world-observation-freshness.js";

export const WORLD_OBSERVATION_BROADCAST_SYSTEM_PROMPT =
  "You turn browser observations into concise Simplified Chinese QQ group updates, returned as structured JSON with an exact source URL per item.";

// 一次播报最多列几条。2026-09-11 起从 5 条收到 3 条，此前 7 天的 78 次播报里有 33 次是满 5 条。
// 改写提示词和发送前的去重循环共用这个数，免得两处写的上限对不上。
export const WORLD_OBSERVATION_BROADCAST_MAX_ITEMS = 3;

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
    `items: at most ${WORLD_OBSERVATION_BROADCAST_MAX_ITEMS} entries. If the observation has MULTIPLE distinct news items, one entry per item (beyond ${WORLD_OBSERVATION_BROADCAST_MAX_ITEMS}, keep the most significant and drop the rest), each a single short Chinese sentence — do not add numbering yourself, it's added automatically. If there is only ONE item, return exactly one entry with 2-4 short conversational sentences.`,
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

// ---------- 打开网页前先筛搜索结果 ----------
//
// 本地搜索对有些话题几乎只给百科和课程网站：查询里只要有「数学」，前几条永远是数学天地、可汗
// 学院、kmath 学习网，换什么说法都一样。这些页面没有日期，打开了必然被 24 小时闸门挡掉，每轮
// 白读三页。搜索结果本身带着标题、网址和摘要，摘要里常写着「8 小时之前」「2026年8月4日」，
// 够模型在打开之前先判断一遍。
//
// 这一步只决定打不打开，不决定发不发：拿不准就留下，后面还有日期闸门和改写那一步把关。所以
// 解析也往宽处走——编号不对的判断直接忽略，模型没提到的结果照旧留下，一条可用的判断都没有就
// 当没筛过。

export const SEARCH_RESULT_JUDGE_SYSTEM_PROMPT =
  "You screen web search results before any page is opened for Holly's world observation, and return structured JSON only.";

export type SearchResultForJudge = { title: string; url: string; snippet: string };

export function buildSearchResultJudgePrompt(input: {
  topic: string;
  topicBrief: string;
  nowLabel: string;
  sinceLabel: string;
  results: readonly SearchResultForJudge[];
}): string {
  const resultsBlock = input.results
    .map((result, index) => [
      `${index + 1}. ${result.title || "(untitled)"}`,
      `   url: ${result.url}`,
      `   snippet: ${result.snippet || "(none)"}`,
    ].join("\n"))
    .join("\n");
  return [
    "Decide which of these search results are worth opening for a news update on the topic below.",
    "Keep a result when it is likely a news article, a news or research-update listing, or an announcement page that keeps getting new items.",
    "Drop encyclopedia and dictionary entries, courses and learning material, beginner explainers, Q&A and forum threads, tool or product home pages, and anything outside the topic scope.",
    "Drop a result whose snippet clearly dates it before the window below, unless it is a listing that keeps updating.",
    "When unsure, keep it: a later step checks every page's dates before anything is sent.",
    'Return JSON only: {"decisions": [{"index": number, "keep": boolean, "reason": string}]}, one decision per result. reason: a few words in Simplified Chinese.',
    "",
    `It is now ${input.nowLabel} (Beijing time); the window starts at ${input.sinceLabel}.`,
    `topic: ${input.topic}`,
    ...(input.topicBrief ? [`topic scope: ${input.topicBrief}`] : []),
    "",
    "Search results:",
    resultsBlock || "(none)",
  ].join("\n");
}

export const SEARCH_RESULT_JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "keep", "reason"],
        properties: {
          index: { type: "integer" },
          keep: { type: "boolean" },
          reason: { type: "string" },
        },
      },
    },
  },
};

export type JudgedSearchResults<T> = {
  kept: T[];
  dropped: Array<{ result: T; reason: string }>;
};

// 编号从 1 开始，和提示词里的列表一致。同一编号判了两次，以第一次为准。
export function selectJudgedSearchResults<T>(raw: unknown, results: readonly T[]): JudgedSearchResults<T> | null {
  const decisions = raw && typeof raw === "object" ? (raw as { decisions?: unknown }).decisions : undefined;
  if (!Array.isArray(decisions)) return null;
  const verdicts = new Map<number, { keep: boolean; reason: string }>();
  for (const decision of decisions) {
    if (!decision || typeof decision !== "object") continue;
    const record = decision as Record<string, unknown>;
    const index = record.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > results.length) continue;
    if (typeof record.keep !== "boolean" || verdicts.has(index)) continue;
    verdicts.set(index, { keep: record.keep, reason: typeof record.reason === "string" ? record.reason.trim() : "" });
  }
  if (verdicts.size === 0) return null;
  const selection: JudgedSearchResults<T> = { kept: [], dropped: [] };
  results.forEach((result, position) => {
    const verdict = verdicts.get(position + 1);
    if (verdict && !verdict.keep) selection.dropped.push({ result, reason: verdict.reason });
    else selection.kept.push(result);
  });
  return selection;
}

export const MEMORY_REFLECTION_SYSTEM_PROMPT =
  "You write Holly's private internal memory. Be concise, concrete, and do not roleplay a public chat reply.";

// Split into the half that repeats between calls and the half that does not, so
// the caller can put a cache breakpoint between them. The instructions and the
// world observations are shared by consecutive ticks (a new observation only
// appears when Holly goes looking); now/reason and the memory and
// conversation windows change on nearly every call, and used to sit *ahead* of
// the material — a timestamp at the front of the prefix invalidates everything
// after it, so the order matters as much as the split.
// stable 按块给：指令一块，每条世界观察各一块。调用方把每块作为一条消息发出去，在线上它们是同一条
// user 消息里相邻的文本块。缓存按块比对前缀——整段拼成一块时，窗口里每多一条观察这一块的字节就变，
// 前缀跟着作废：2026-09-08 到 09-11，归档写作 29 次调用缓存读取为 0，记忆反思 88 次只读回 16.7%。
// 分块之后新观察只是在后面多一块，前面的块原样命中；只有窗口起点移动才真的重建。
export type SplitPrompt = { stable: string[]; volatile: string };

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
    stable: [MEMORY_REFLECTION_INSTRUCTIONS.join("\n"), ...stableMaterial],
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
    stable: [ARCHIVE_COMPOSITION_INSTRUCTIONS.join("\n"), ...stableMaterial],
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

// 世界观察可选时，逐个话题列出上次什么时候看的、看完怎样了。判断「要不要去、看哪个」要的就是这几条
// 事实：刚看过又发了的话题不急，上次页面上没新东西的可以缓缓，很久没看的才可能攒了新动态。分钟数
// 跟 autonomy-engine.ts 的 freshnessNote 一样取整分钟，同一段提示词里不混两种写法。
function worldTopicLines(topics: readonly WorldTopicStatus[], nowMs: number): string[] {
  return topics.map((status) => {
    const when = status.lastAt > 0
      ? `${Math.max(0, Math.round((nowMs - status.lastAt) / 60_000))} 分钟前看过`
      : "最近没有看过的记录";
    return `  · ${status.topic}：${when}${status.outcome ? `，${status.outcome}` : ""}`;
  });
}

// 最近已经写过的题目。世界观察有 worldTopicLines 逐话题报近况，记忆反思和归档写作以前
// 什么都没有——判断层看到的只是「可选」，看不见她上一轮刚写完什么，于是同一件事能连着
// 写好几遍。
//
// 末尾那句「是让你避开」不是客套。只给一份清单，模型会把它当成范例照着写，去重反而变成
// 了复读机；必须说明白列出来是为了绕开。
function recentActionLines(
  actions: readonly RecentAutonomyAction[] | undefined,
  nowMs: number,
): string[] {
  // 类型上这是必填的，但缺了它也只该少掉几行去重提示，不该让整条提示词构建抛出去——
  // 那一轮判断调用会整个失败，她这一分钟什么都做不了。这份清单是锦上添花，不是必需品。
  if (!actions || actions.length === 0) return [];
  const label: Record<RecentAutonomyAction["kind"], string> = {
    memory_reflection: "记忆",
    archive_writing: "作品",
  };
  return [
    "最近已经写过的（这次换点别的，列在这里是让你避开，不是给你参照写法）：",
    // 最新的写在最前面：刚写完的那个最该避开，读到第一行就看见。
    ...[...actions].reverse().map((action) => {
      const when = action.at > 0
        ? `${Math.max(0, Math.round((nowMs - action.at) / 60_000))} 分钟前`
        : "时间不详";
      return `  · ${when}｜${label[action.kind]}：${action.title}`;
    }),
  ];
}

export function buildAutonomyJudgmentPrompt(request: AutonomyJudgmentRequest): string {
  return [
    "现在是自主循环的一次 tick。下面是当前可以从中选择的候选，只列出真实状态，没有对话内容。",
    "",
    candidateLine("world_observation（浏览网页，产出一条世界观察）", request.worldObservation),
    ...worldTopicLines(request.worldTopics, Date.parse(request.nowIso)),
    candidateLine("memory_reflection（写一条内部记忆）", request.memoryReflection),
    candidateLine("archive_writing（写一篇文章或一首诗）", request.archiveWriting),
    `- group_proactive（主动在某个群里接话）: 可选 — ${request.groupProactiveNote}`,
    "",
    `当前有 ${request.pendingReplyGroupCount} 个群有未读消息在等待独立的回复判断——这条仅供感知，不需要你处理，不要选它作为理由去做别的事，也不要因为它而选 do_nothing。`,
    `上次行动：${request.lastActionSummary}`,
    ...recentActionLines(request.recentActions, Date.parse(request.nowIso)),
    "",
    "从「可选」的候选里挑一个最值得现在做的，或者选 do_nothing（这一轮什么都不做也完全正常，大多数 tick 应该如此）。",
    "不可选的候选禁止选中——它们的 interval/重试窗口还没到。",
    "world_observation 没有固定间隔，几乎一直可选，这不代表该去。只有真对某个话题起了兴趣、想看看它最近有什么新动态时才选它，并在 topic 里填那个话题的原文：挑现在最好奇、也最可能攒了新东西的。刚看过的话题（尤其几十分钟内看过的）、上次没看到新东西的话题，再去多半还是同样的内容。看完要不要发到群里，之后会单独判断，不用在这里考虑。",
    "archive_writing 同样没有固定间隔。写不写、什么时候写由你自己定：有真想写下来的东西才写，没有就不写，这不是一件到点要交的功课。",
    "选其他动作时 topic 填空串。",
    "返回 JSON only，shape：",
    '{"action": "do_nothing" | "world_observation" | "memory_reflection" | "archive_writing" | "group_proactive", "topic": "话题原文；不是 world_observation 时填空串", "reason": "一句简短中文，说明为什么选它（或为什么什么都不做）"}',
  ].join("\n");
}

// ---------- 看完之后要不要发到群里 ----------
//
// 播报以前只要过了日期、冷场、去重几道闸就一定发出去，Holly 自己从没被问过「这条想不想说」。闸门只
// 回答得了「能不能发」——是不是最近 24 小时的、群里是不是正在聊、是不是发过了；回答不了「值不值得
// 发」：一条增量很小的融资消息、连着几轮没人接的播报、跟群里气氛完全不搭的内容，闸门统统放行。
//
// 这一步放在改写之后：交给她的是真正会发出去的那几条中文，已经过了日期和去重。放在改写之前，她得
// 先读几页原始网页摘录才判断得了，读的还多半是注定被日期闸门筛掉的噪声。代价是她说不发时，那次
// 改写白做了。闸门照旧在前面拦，这一步只在「能发」的稿子里挑「想发」的，不替代任何一道闸。

export const WORLD_OBSERVATION_SHARE_SYSTEM_PROMPT =
  "You are Holly, deciding whether to share news you just read with one of your QQ groups. Return structured JSON only.";

export type WorldObservationShareTurn = { timestamp: string; speaker: string; content: string };

export function buildWorldObservationSharePrompt(input: {
  topic: string;
  // 北京时间，形如「2026-09-11 13:00」。
  nowLabel: string;
  groupId: string;
  // 群里最后一条消息距今几分钟；null 表示查不到。
  idleMinutes: number | null;
  // 从旧到新。
  recentTurns: readonly WorldObservationShareTurn[];
  draft: string;
}): string {
  const turnsBlock = input.recentTurns
    .map((turn) => `- [${turn.timestamp}] ${turn.speaker}: ${turn.content}`)
    .join("\n");
  return [
    `你是 Holly。你刚自己上网看了看「${input.topic}」最近的动态，整理出了下面这条消息，准备发到群 ${input.groupId}。发不发由你决定。`,
    "值得发：你自己确实觉得有意思，群里的人大概也会想知道，是你平时也会主动跟朋友提一句的东西。",
    "可以不发的情况：内容平淡，或者只是很小的进展；你最近已经在这个群发过几条类似的消息却没人接话，再发就成了自说自话；群里正聊着别的事，插进去很突兀；现在这个时间点发不合适。",
    "不用每次看到新闻都发，不发完全正常，看过的东西照样留在你的记忆里。只判断发不发，不要改写这条消息。",
    '返回 JSON only，shape：{"send": true | false, "reason": "一句简短中文，说明为什么发或不发"}',
    "",
    `现在是 ${input.nowLabel}（北京时间）。`,
    input.idleMinutes === null ? "群里最后一条消息是什么时候：不清楚。" : `群里最后一条消息在 ${input.idleMinutes} 分钟前。`,
    "",
    "群里最近的聊天（从旧到新，Holly 就是你自己）：",
    turnsBlock || "(没有记录)",
    "",
    "准备发出的消息：",
    input.draft,
  ].join("\n");
}

export const WORLD_OBSERVATION_SHARE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["send", "reason"],
  properties: {
    send: { type: "boolean" },
    reason: { type: "string" },
  },
};

export type WorldObservationShareDecision = { send: boolean; reason: string };

// send 必须是真正的布尔值，"true" 这样的字符串不算。解析不出表态就返回 null，调用方按「没点头」处理：不发。
export function parseWorldObservationShareDecision(raw: unknown): WorldObservationShareDecision | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.send !== "boolean") return null;
  return { send: record.send, reason: typeof record.reason === "string" ? record.reason.trim() : "" };
}
