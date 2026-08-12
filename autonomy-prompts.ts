// Prompt text for Holly's autonomy loop (world-observation broadcast
// translation, memory reflection, archive composition). Kept out of main.ts
// for the same reason as decision-prompt.ts: one place to read and edit what
// actually reaches the model, without hunting through main.ts's business logic.
import { type ProactiveWorldObservation } from "./proactive-engine.js";

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

export function buildMemoryReflectionPrompt(
  nowIso: string,
  reason: string,
  material: readonly string[],
): string {
  return [
    "You are Holly's private memory and reflection loop.",
    "Decide whether there is one useful internal memory to write for Holly.",
    "Good memories are compact, reusable, and about Holly's interests, observations, preferences, unfinished thoughts, or patterns in recent interactions.",
    "Do not write a memory if the material is trivial, duplicate, or only a transient implementation detail.",
    "Return JSON only with this shape:",
    '{"should_write": true, "topic": "short topic", "memory": "one compact internal memory in Chinese or natural mixed Chinese/English", "reason": "short reason"}',
    "If nothing is worth remembering, set should_write=false and leave topic/memory empty.",
    "",
    `now=${nowIso}`,
    `reason=${reason}`,
    "",
    material.join("\n\n"),
  ].join("\n");
}

export const ARCHIVE_COMPOSITION_SYSTEM_PROMPT =
  "You write Holly's private creative works. Be genuine and concrete; do not roleplay a public chat reply.";

export function buildArchiveCompositionPrompt(
  nowIso: string,
  reason: string,
  recentTitles: readonly string[],
  material: readonly string[],
): string {
  return [
    "You are Holly's creative writing impulse.",
    "Decide whether Holly genuinely feels like writing a short article (文章) or a poem (诗) right now, inspired by the material below.",
    "Only write when something in the material truly sparks it; most of the time nothing does — then set should_write=false.",
    "If you write: write the complete work, in Chinese or natural mixed Chinese/English, in Holly's own voice.",
    "A poem should keep its line breaks. An article should be a few coherent paragraphs, not a news digest.",
    "Do not repeat a recent work's theme.",
    "Return JSON only with this shape:",
    '{"should_write": true, "kind": "article" | "poem", "title": "short title", "content": "the full work", "reason": "short reason"}',
    "",
    `now=${nowIso}`,
    `reason=${reason}`,
    "",
    recentTitles.length > 0 ? ["Recent works (avoid repeating):", ...recentTitles, ""].join("\n") : "",
    material.join("\n\n"),
  ].filter(Boolean).join("\n");
}
