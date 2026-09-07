// Prompt text for Holly's autonomy loop (world-observation broadcast
// translation, memory reflection, archive composition, and the per-tick
// judgment call that picks which of them to attempt). Kept out of main.ts
// for the same reason as decision-prompt.ts: one place to read and edit what
// actually reaches the model, without hunting through main.ts's business logic.
import { type ProactiveWorldObservation } from "./proactive-engine.js";
import { type AutonomyJudgmentRequest } from "./autonomy-engine.js";

export const WORLD_OBSERVATION_BROADCAST_SYSTEM_PROMPT =
  "You turn browser observations into concise Simplified Chinese QQ group updates, returned as structured JSON with an exact source URL per item.";

export type WorldObservationLinkCandidate = { text: string; url: string };

export function buildWorldObservationBroadcastPrompt(
  topic: string,
  observation: ProactiveWorldObservation,
  candidates: readonly WorldObservationLinkCandidate[],
): string {
  const linksBlock = candidates
    .map((candidate, index) => `${index + 1}. ${candidate.text ? `${candidate.text} — ` : ""}${candidate.url}`)
    .join("\n");
  return [
    "Condense this browser world observation into Simplified Chinese for a QQ group.",
    "Keep the factual content. Do not mention that it was translated or that this is automated.",
    'Return JSON only: {"intro": string, "items": [{"text": string, "url": string}]}.',
    'intro: an optional short lead-in sentence, or "" if not needed.',
    "items: at most 5 entries. If the observation has MULTIPLE distinct news items, one entry per item (drop the rest beyond 5), each a single short Chinese sentence — do not add numbering yourself, it's added automatically. If there is only ONE item, return exactly one entry with 2-4 short conversational sentences.",
    "Each item's `url` MUST be copied EXACTLY (character for character) from the numbered candidate list below — pick the entry that most specifically matches that item (a specific article/detail link) over a generic page-source entry, unless the page source is the only candidate for that item.",
    "Never invent, shorten, or rewrite a URL — only the candidate list's exact strings are valid.",
    "No markdown, no @ mentions. Keep each item's text under 120 Chinese characters.",
    "If the source text is noisy, keep only the most useful concrete points.",
    "When at least one concrete factual item is present, items MUST contain at least one entry; do not return an empty items array merely because some sources are listing pages or noisy.",
    "",
    `topic: ${topic}`,
    `query: ${observation.query}`,
    "",
    "Candidate links (url must be copied exactly from here):",
    linksBlock || "(none)",
    "",
    "world observation:",
    observation.summary,
  ].join("\n");
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
