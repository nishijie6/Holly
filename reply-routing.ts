import { detectIncompleteFinalAnswer } from "./decision-prompt.js";
import { sanitizeFinalAnswer, type ModelDecision } from "./model-decision.js";
import type { LlmMessage } from "./llm-client.js";

const FINAL_REPLY_SYSTEM_PROMPT = [
  "You turn an already-approved draft into Holly's final sendable QQ reply.",
  "Return only the reply text, with no JSON, labels, analysis, or markdown fence.",
  "Preserve the draft's facts, URLs, administrator-action status, and uncertainty.",
  "Do not add promises, claims, actions, searches, or facts that are absent from the draft.",
  "Keep the natural short Chinese style required by the draft.",
].join("\n");

export type FinalReplyGenerationInput = {
  systemPrompt: string;
  messages: LlmMessage[];
};

export type RefineDecisionReplyInput = {
  decision: ModelDecision;
  decisionModel: string;
  responseModel: string;
  generateFinalAnswer: (input: FinalReplyGenerationInput) => Promise<string>;
};

export type RefineDecisionReplyResult = {
  decision: ModelDecision;
  responseModel: string;
  usedFallback: boolean;
  error: string | null;
};

export function appendRetryFeedbackToVolatileTail(
  messages: LlmMessage[],
  feedback: readonly string[],
): LlmMessage[] {
  const text = feedback.join("\n").trim();
  if (!text) return messages;
  const last = messages.at(-1);
  if (!last || last.role !== "user") {
    return [...messages, { role: "user", content: text }];
  }
  return [
    ...messages.slice(0, -1),
    { ...last, content: `${last.content.trim()}\n\n${text}` },
  ];
}

export async function refineDecisionReply(
  input: RefineDecisionReplyInput,
): Promise<RefineDecisionReplyResult> {
  const { decision, decisionModel, responseModel } = input;
  if (
    !decision.shouldReply
    || !decision.finalAnswer
    || decisionModel === responseModel
    || decision.adminActionStatus !== null
  ) {
    return { decision, responseModel: decisionModel, usedFallback: false, error: null };
  }

  try {
    const raw = await input.generateFinalAnswer({
      systemPrompt: FINAL_REPLY_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Approved draft:\n${decision.finalAnswer}`,
      }],
    });
    const trimmedRaw = raw.trim();
    if (
      trimmedRaw.includes("```")
      || (/^[\[{]/.test(trimmedRaw) && /[\]}]$/.test(trimmedRaw))
      || /^(?:thinking_process|thinking process|reasoning_summary|reasoning summary|should_reply|final_answer)\s*[:：]/im.test(trimmedRaw)
    ) {
      return {
        decision,
        responseModel: decisionModel,
        usedFallback: true,
        error: "response model returned structured or meta output",
      };
    }
    const finalAnswer = sanitizeFinalAnswer(raw);
    const incompleteReason = finalAnswer ? detectIncompleteFinalAnswer(finalAnswer) : "empty final answer";
    if (!finalAnswer || incompleteReason) {
      return {
        decision,
        responseModel: decisionModel,
        usedFallback: true,
        error: incompleteReason || "empty final answer",
      };
    }

    const extractUrls = (text: string): string[] => (
      text.match(/https?:\/\/[^\s<>()\[\]{}"']+/giu) ?? []
    ).map((url) => url.replace(/[.,;:!?，。；：！？]+$/u, ""));
    const finalUrls = new Set(extractUrls(finalAnswer));
    const missingUrl = extractUrls(decision.finalAnswer).find((url) => !finalUrls.has(url));
    if (missingUrl) {
      return {
        decision,
        responseModel: decisionModel,
        usedFallback: true,
        error: `response model removed URL: ${missingUrl}`,
      };
    }

    return {
      decision: { ...decision, finalAnswer },
      responseModel,
      usedFallback: false,
      error: null,
    };
  } catch (error) {
    return {
      decision,
      responseModel: decisionModel,
      usedFallback: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
