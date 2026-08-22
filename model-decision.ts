// Parsing and normalization of the JSON decision the model returns.
// Extracted verbatim from main.ts; behaviour is deliberately unchanged.

import { stripGroupReplyPrefix } from "./decision-prompt.js";
import type { AdminActionStatus } from "./admin-policy.js";

export type ModelDecision = {
  shouldReply: boolean;
  finalAnswer: string;
  thinkingProcess: string;
  adminActionStatus: AdminActionStatus | null;
  adminActionReason: string;
  raw: string;
};

export function unwrapJsonBlock(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```[a-zA-Z]*\s*/, "")
      .replace(/\s*```$/, "")
      .trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

export function readDecisionText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .join("; ");
  }

  return "";
}

export function keepTextAfterLastMarker(text: string, marker: RegExp): string {
  const matches = Array.from(text.matchAll(marker));
  if (matches.length === 0) {
    return text;
  }

  const lastMatch = matches[matches.length - 1];
  if (typeof lastMatch.index !== "number") {
    return text;
  }

  const start = lastMatch.index + lastMatch[0].length;

  return text.slice(start).trim();
}

export function sanitizeFinalAnswer(text: string): string {
  let cleaned = text.trim();
  if (!cleaned) {
    return "";
  }

  cleaned = keepTextAfterLastMarker(
    cleaned,
    /(?:\u6700\u7ec8\u56de\u7b54|\u6700\u7ec8\u56de\u590d|final_answer|final answer)\s*[:\uFF1A]/gi,
  );

  if (
    /^(?:\u601d\u8def\u6458\u8981|\u601d\u8003\u8fc7\u7a0b|reasoning_summary|reasoning summary|thought summary|thinking_process|thinking process)\s*[:\uFF1A]?/i.test(cleaned)
  ) {
    const lines = cleaned.split(/\r?\n/);
    const answerLines: string[] = [];
    let skippingMeta = true;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        if (!skippingMeta) {
          answerLines.push(rawLine);
        }
        continue;
      }

      if (skippingMeta) {
        if (
          /^(?:\u601d\u8def\u6458\u8981|\u601d\u8003\u8fc7\u7a0b|reasoning_summary|reasoning summary|thought summary|thinking_process|thinking process)\s*[:\uFF1A]?/i.test(line) ||
          /^(?:[-*\u2022]|\d+\.)\s*/.test(line) ||
          /^(?:answer|should_reply|shouldReply|reply)\s*[:\uFF1A]\s*(?:true|false)\s*$/i.test(line)
        ) {
          continue;
        }

        skippingMeta = false;
      }

      answerLines.push(rawLine);
    }

    cleaned = answerLines.join("\n").trim();
  }

  cleaned = cleaned
    .replace(/^(?:answer|should_reply|shouldReply|reply)\s*[:\uFF1A]\s*(?:true|false)\s*/i, "")
    .replace(/^(?:\u6700\u7ec8\u56de\u7b54|\u6700\u7ec8\u56de\u590d|final_answer|final answer)\s*[:\uFF1A]\s*/i, "")
    .trim();

  // The context labels turns with group tags ("[\u7fa4123456]"\u3001"\u7fa4\u804a [..] [..]");
  // the model occasionally mimics them at the start of a reply. Never send those.
  return stripGroupReplyPrefix(cleaned);
}

export function sanitizeThinkingProcess(text: string): string {
  return text
    .trim()
    .replace(
      /^(?:\u601d\u8003\u8fc7\u7a0b|\u601d\u8def\u6458\u8981|thinking_process|thinking process|reasoning_summary|reasoning summary|thought summary)\s*[:\uFF1A]\s*/i,
      "",
    )
    .trim();
}

export function readAdminActionStatus(value: unknown): AdminActionStatus | null {
  return value === "not_a_command"
    || value === "accepted"
    || value === "completed"
    || value === "cannot_comply"
    ? value
    : null;
}

export function parseModelDecision(raw: string): ModelDecision {
  const normalized = unwrapJsonBlock(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error(`Model response is not valid JSON: ${raw}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Model response must be a JSON object: ${raw}`);
  }

  const payload = parsed as Record<string, unknown>;
  const shouldReply =
    payload.should_reply === true ||
    payload.shouldReply === true ||
    payload.reply === true ||
    payload.should_reply === "true" ||
    payload.shouldReply === "true";
  const finalAnswer = sanitizeFinalAnswer(
    readDecisionText(payload.final_answer ?? payload.finalAnswer),
  );
  const thinkingProcess = sanitizeThinkingProcess(
    readDecisionText(
      payload.thinking_process ??
      payload.thinkingProcess ??
      payload.reasoning_summary ??
      payload.reasoningSummary ??
      payload.thought_summary ??
      payload.thoughtSummary,
    ),
  );
  const adminActionStatus = readAdminActionStatus(payload.admin_action_status);
  const adminActionReason = sanitizeThinkingProcess(readDecisionText(payload.admin_action_reason));

  return {
    shouldReply,
    finalAnswer,
    thinkingProcess,
    adminActionStatus,
    adminActionReason,
    raw,
  };
}

export function formatModelReplyEntry(decision: ModelDecision): string {
  const lines = [
    `是否回复: ${decision.shouldReply ? "是" : "否"}`,
    `思考过程: ${decision.thinkingProcess || "（空）"}`,
    `最终回复: ${decision.finalAnswer || "（空）"}`,
  ];
  if (decision.adminActionStatus) {
    lines.push(`管理员动作: ${decision.adminActionStatus}`);
    lines.push(`动作说明: ${decision.adminActionReason || "（空）"}`);
  }

  if (!decision.shouldReply) {
    lines.push("回复状态: 跳过");
    lines.push("跳过原因: 模型判定该消息与自己无关，不会发送。");
  } else if (!decision.finalAnswer) {
    lines.push("回复状态: 跳过");
    lines.push("跳过原因: 模型选择回复，但最终回复内容为空。");
  } else {
    lines.push("回复状态: 待发送");
  }

  return lines.join("\n");
}
