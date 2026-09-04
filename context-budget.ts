// Token estimation, text compaction, and context-budget allocation.
// Extracted verbatim from main.ts; behaviour is deliberately unchanged.

import type { LlmMessage } from "./llm-client.js";

const CONTEXT_MIN_SECTION_BUDGET = 48;

export function estimateTextTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }

  let total = 0;
  let asciiRun = 0;

  const flushAsciiRun = (): void => {
    if (asciiRun <= 0) {
      return;
    }

    total += Math.max(1, Math.ceil(asciiRun / 4));
    asciiRun = 0;
  };

  for (const char of normalized) {
    if (/\s/u.test(char)) {
      flushAsciiRun();
      continue;
    }

    if (/\p{Script=Han}/u.test(char)) {
      flushAsciiRun();
      total += 1;
      continue;
    }

    if (/[A-Za-z0-9]/.test(char)) {
      asciiRun += 1;
      continue;
    }

    flushAsciiRun();
    total += 1;
  }

  flushAsciiRun();
  return Math.max(1, total);
}

export function estimateSystemPromptTokens(systemPrompt: string): number {
  const normalized = systemPrompt.trim();
  return normalized ? estimateTextTokens(normalized) + 12 : 0;
}

export function estimateMessageTokens(message: LlmMessage): number {
  // Tool blocks are not decoration: in the focus pipeline a tool_result holds a
  // whole rendered conversation, so a turn whose content is "" can still be
  // thousands of tokens. Counting only `content` would report such a transcript
  // as nearly free and let it grow past any budget unnoticed.
  const blockTokens = (message.blocks ?? []).reduce((sum, block) => {
    if (block.type === "tool_use") {
      return sum + estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.input)) + 4;
    }
    return sum + estimateTextTokens(block.content) + 4;
  }, 0);
  return estimateTextTokens(message.content) + blockTokens + 6;
}

export function estimateMessagesTokens(messages: readonly LlmMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export function estimateRequestTokens(systemPrompt: string, messages: readonly LlmMessage[]): number {
  return estimateSystemPromptTokens(systemPrompt) + estimateMessagesTokens(messages);
}

export function normalizeMessageContent(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function compactTextToTokenBudget(text: string, maxTokens: number): string {
  const normalized = normalizeMessageContent(text);
  if (!normalized || maxTokens <= 0) {
    return "";
  }

  if (estimateTextTokens(normalized) <= maxTokens) {
    return normalized;
  }

  const chars = Array.from(normalized);
  let headChars = Math.min(chars.length, Math.max(12, Math.floor(maxTokens * 1.8)));
  let tailChars = maxTokens >= 40 ? Math.min(chars.length - headChars, Math.floor(maxTokens * 0.6)) : 0;
  let candidate = `${chars.slice(0, headChars).join("")}${tailChars > 0 ? ` ... ${chars.slice(-tailChars).join("")}` : "..."}`.trim();

  while (estimateTextTokens(candidate) > maxTokens && (headChars > 8 || tailChars > 0)) {
    if (tailChars > 0 && headChars >= tailChars) {
      tailChars = Math.max(0, tailChars - 4);
    } else {
      headChars = Math.max(8, headChars - 6);
    }

    candidate = `${chars.slice(0, headChars).join("")}${tailChars > 0 ? ` ... ${chars.slice(-tailChars).join("")}` : "..."}`.trim();
  }

  while (estimateTextTokens(candidate) > maxTokens && headChars > 4) {
    headChars = Math.max(4, headChars - 2);
    candidate = `${chars.slice(0, headChars).join("")}...`.trim();
  }

  return candidate;
}

export function sanitizeConversationMessages(messages: readonly LlmMessage[]): LlmMessage[] {
  return messages
    .map((message): LlmMessage => ({
      role: message.role,
      content: normalizeMessageContent(message.content),
    }))
    .filter((message) => Boolean(message.content));
}

export function formatTopicTimestamp(ts: number | null): string {
  if (ts === null) {
    return "??";
  }

  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function compressMemoryPrompt(memoryPrompt: string, budgetTokens: number): string {
  const normalized = memoryPrompt.trim();
  if (!normalized || budgetTokens <= 0) {
    return "";
  }

  if (estimateTextTokens(normalized) <= budgetTokens) {
    return normalized;
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith("["));

  if (lines.length === 0) {
    return compactTextToTokenBudget(normalized, budgetTokens);
  }

  const header = "Compressed thread memory:";
  let result = header;
  const perLineBudget = Math.max(
    10,
    Math.min(56, Math.floor(Math.max(1, budgetTokens - estimateTextTokens(header)) / lines.length)),
  );

  for (const line of lines) {
    const compactLine = `- ${compactTextToTokenBudget(line.replace(/\s+\[thread_score=.*$/, ""), perLineBudget)}`;
    const next = `${result}\n${compactLine}`;
    if (estimateTextTokens(next) > budgetTokens) {
      break;
    }

    result = next;
  }

  return result === header ? compactTextToTokenBudget(header, budgetTokens) : result;
}

export function allocateVariableContextBudgets(
  memoryTokens: number,
  conversationTokens: number,
  totalBudget: number,
): { memoryBudget: number; conversationBudget: number } {
  if (totalBudget <= 0) {
    return { memoryBudget: 0, conversationBudget: 0 };
  }

  if (memoryTokens <= 0) {
    return { memoryBudget: 0, conversationBudget: totalBudget };
  }

  if (conversationTokens <= 0) {
    return { memoryBudget: totalBudget, conversationBudget: 0 };
  }

  const totalTokens = memoryTokens + conversationTokens;
  let memoryBudget = Math.round(totalBudget * (memoryTokens / totalTokens));
  let conversationBudget = totalBudget - memoryBudget;
  const minimumSectionBudget = Math.min(CONTEXT_MIN_SECTION_BUDGET, Math.floor(totalBudget / 4));

  if (memoryBudget < minimumSectionBudget) {
    const delta = minimumSectionBudget - memoryBudget;
    memoryBudget += delta;
    conversationBudget = Math.max(0, conversationBudget - delta);
  }

  if (conversationBudget < minimumSectionBudget) {
    const delta = minimumSectionBudget - conversationBudget;
    conversationBudget += delta;
    memoryBudget = Math.max(0, memoryBudget - delta);
  }

  return { memoryBudget, conversationBudget };
}

export function modelContextWindowTokens(model: string): number {
  // Haiku 4.5 has a 200K window; Opus 4.x and Sonnet 4.6 are 1M.
  return /haiku/i.test(model) ? 200_000 : 1_000_000;
}
