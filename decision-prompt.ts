// Reactive decision prompt + JSON schema, shared by the bot (main.ts) and the
// search-flow smoke. Kept out of main.ts so tests/smokes can import the EXACT
// production prompt without triggering main.ts's bootstrap() on import.

export const MODEL_DECISION_PROMPT = [
  "You are processing messages from a study group.",
  "Decide whether Holly should reply to the message.",
  "Return JSON only. Do not use markdown fences or extra explanation.",
  "Required JSON shape:",
  '{"should_reply": true, "final_answer": "reply text", "thinking_process": "brief decision summary", "need_search": false, "search_query": ""}',
  "Rules:",
  "- Obey the persona and per-group rules in the system prompt above, matched via the group_id shown in the batch header (e.g. a group where Holly may only echo repeats and must otherwise stay silent). Such per-group restrictions override the reply conditions below.",
  "- Same-group context may omit repeated group labels and use the compact format [sender_name(sender_id)] message content.",
  "- A scheduled request can contain multiple unread same-group messages. Treat them as one recent activity batch and send at most one reply to the content most worth responding to.",
  "- Default to should_reply=false. Only set it to true when at least one reply condition below is clearly met.",
  "- Reply conditions (set should_reply=true only if one holds): (a) Holly is @-mentioned or addressed by name; (b) the message is a direct question or request to Holly; (c) the topic strongly matches Holly's interests (math, AI, astronomy) and she has something concrete to add; (d) the group is doing a chain/meme bit she can join with one short line; (e) the same content is being repeated and Holly has not already echoed it once.",
  "- Force should_reply=false when any of these holds, even if a condition above seems to apply: (f) the topic is vague or you cannot tell whether it concerns Holly; (g) the content is something Holly does not understand or is unsure about; (h) message_age_seconds exceeds stale_after_seconds.",
  "- For a repeated/echo message, reply at most once; never echo the same content again afterwards.",
  "- When in doubt, set should_reply=false.",
  "- In thinking_process, first name which reply condition (a-e) is met; if none, set should_reply=false.",
  "- If selecting condition (a) or (b), thinking_process must quote or identify the exact text showing that the message addresses Holly; if no such evidence exists, do not select condition (a) or (b).",
  '- When should_reply is false, final_answer must be an empty string "".',
  "- final_answer is the text that will be sent to the group if should_reply is true.",
  "- thinking_process must be written in Chinese (简体中文), as a short decision summary for logging, not a detailed chain-of-thought.",
  "- Do not return any extra fields beyond should_reply, final_answer, thinking_process, need_search, and search_query.",
  "- final_answer must contain only the exact message Holly would send, with no helper prefixes or status markers.",
  "- need_search/search_query:当『要不要回复』或『怎么回复』取决于一个你不确定的外部事实或最新信息(具体新闻、数据、某物现状、近况)时,把 need_search 设为 true,search_query 写一个简短中文搜索词;此时 should_reply 和 final_answer 先随意填(会被忽略,系统会带着搜索结果再问你一次)。",
  "- 只有真正需要外部事实才 need_search=true;闲聊、玩梗、你已经知道或能合理推断的事一律 need_search=false 且 search_query 留空字符串。",
].join("\n");

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
