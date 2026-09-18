// Reactive decision prompt + JSON schema, shared by the bot (main.ts) and the
// search-flow smoke. Kept out of main.ts so tests/smokes can import the EXACT
// production prompt without triggering main.ts's bootstrap() on import.

import { loadPromptText } from "./prompt-text.js";

// 正文在 prompts/model-decision.md。测试与 smoke 照旧从这里导入,拿到的仍是生产用的那一份。
export const MODEL_DECISION_PROMPT = loadPromptText("model-decision");

export const MODEL_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    should_reply: { type: "boolean" },
    final_answer: { type: "string" },
    thinking_process: { type: "string" },
    // "查一下再答":当决定取决于一个不确定的外部事实时,模型置 need_search=true +
    // search_query;系统搜完带结果再问一次。required(而非 optional)以兼容严格结构化
    // 输出的 provider;主动式/非搜索场景固定 need_search=false。
    need_search: { type: "boolean" },
    search_query: { type: "string" },
  },
  required: ["should_reply", "final_answer", "thinking_process", "need_search", "search_query"],
  additionalProperties: false,
};

export function buildModelSystemPrompt(basePrompt: string): string {
  return `${basePrompt}\n\n${MODEL_DECISION_PROMPT}`;
}

// Context-format prefixes the model sometimes mimics at the start of a reply.
// The merged context labels turns as "[MM-DD HH:MM] ..." (send time),
// "[群123456] ...", "群聊 [群名(群号)] [发送人(编号)] ..." or "[发送人(编号)]
// ...", and batch headers carry "group_id: 123456" — none of that belongs in
// the message actually sent to the group. Every pattern requires digits or the exact bracket shape so a reply
// that merely starts with 群/[ stays intact (bare "群123456" without a colon is
// left alone too — it could be Holly talking about a group).
const REPLY_META_PREFIX_PATTERNS: readonly RegExp[] = [
  /^\[\d{2}-\d{2} \d{2}:\d{2}\]\s*[:：]?\s*/u,
  /^群聊\s*\[[^\]\n]+\]\s*\[[^\]\n]+\]\s*[:：]?\s*/u,
  /^\[群\s*\d+\]\s*[:：]?\s*/u,
  /^群\s*\d+\s*[:：]\s*/u,
  /^\[[^\]\n]{1,24}\(\d{4,15}\)\]\s*[:：]?\s*/u,
  /^group(?:_id)?\s*[=:：]\s*\d+\s*[:：]?\s*/i,
];

export function stripGroupReplyPrefix(text: string): string {
  let cleaned = text.trim();
  let changed = true;
  while (changed && cleaned) {
    changed = false;
    for (const pattern of REPLY_META_PREFIX_PATTERNS) {
      const next = cleaned.replace(pattern, "").trimStart();
      if (next !== cleaned) {
        cleaned = next;
        changed = true;
      }
    }
  }
  return cleaned.trim();
}

export function detectIncompleteFinalAnswer(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const stripped = normalized
    .replace(/[\s"'“”‘’）)\]}】》」』]+$/u, "")
    .trim();
  if (!stripped) return null;

  if (/[，,、：:；;—-]$/u.test(stripped)) {
    return "ends with dangling punctuation";
  }

  const danglingEndings = [
    "因为",
    "所以",
    "但是",
    "不过",
    "然后",
    "而且",
    "如果",
    "虽然",
    "比如",
    "例如",
    "换句话说",
    "也就是说",
    "问题是",
    "关键是",
    "区别是",
    "原因是",
    "而是",
    "不是",
    "属于",
    "等于",
    "在于",
    "是",
  ];
  for (const ending of danglingEndings) {
    if (stripped.endsWith(ending)) {
      return `ends with dangling phrase: ${ending}`;
    }
  }

  if (/\b(?:because|but|and|or|the|of|to|is|are|with|that|which)$/i.test(stripped)) {
    return "ends with dangling English word";
  }

  return null;
}
