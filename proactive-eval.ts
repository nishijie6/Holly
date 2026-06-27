// Gate-B LLM eval for proactive Holly (T12).
//
// Unlike test/*.test.ts (pure logic, no network), this exercises the REAL model
// through the production gate-B prompt (buildProactiveRevivePrompt). It checks:
//   - structural correctness (HARD fail → exit 1): valid JSON, and when
//     should_reply=true the line passes validateProactiveLine + is natural
//     Chinese + not degenerate; when false, final_answer is empty.
//   - decision reasonableness (SOFT, reported only): does should_reply match the
//     scenario's intent. LLMs vary, so this informs rather than gates.
//
// Run:  npm run eval:proactive            (uses the active profile)
//       npm run eval:proactive -- claude_haiku   (cheaper model)
//
// Spends real subscription tokens (5 calls). Needs the proxy/auth the bot uses.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLlmClient, type LlmMessage } from "./llm-client.js";
import { buildProactiveRevivePrompt, validateProactiveLine } from "./proactive-engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = existsSync(join(process.cwd(), "package.json")) ? process.cwd() : __dirname;
const CONFIG_PATH = join(APP_ROOT, "config.yaml");
const MAX_REPLY_CHARS = 80;

// Mirrors MODEL_DECISION_JSON_SCHEMA in main.ts (stable shape; kept inline so the
// eval doesn't have to import the bot entrypoint, which self-starts on import).
const DECISION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    should_reply: { type: "boolean" },
    final_answer: { type: "string" },
    thinking_process: { type: "string" },
  },
  required: ["should_reply", "final_answer", "thinking_process"],
  additionalProperties: false,
};

type Expect = "yes" | "no" | "either";

type Scenario = {
  name: string;
  expect: Expect;
  history: LlmMessage[];
  summary: string;
};

const SCENARIOS: Scenario[] = [
  {
    name: "黑洞话题冷掉(应捡)",
    expect: "yes",
    history: [
      { role: "user", content: "群友A: 昨天看了事件视界望远镜拍黑洞的纪录片" },
      { role: "user", content: "群友B: 那个 M87 的照片是不是 P 的啊哈哈" },
      { role: "user", content: "群友A: 不是 是射电干涉拼出来的" },
    ],
    summary: "群友A: 昨天看了事件视界望远镜拍黑洞的纪录片\n群友B: 那个 M87 的照片是不是 P 的\n群友A: 不是 是射电干涉拼出来的",
  },
  {
    name: "午饭闲聊(不该插)",
    expect: "no",
    history: [
      { role: "user", content: "群友C: 中午吃啥啊" },
      { role: "user", content: "群友D: 楼下黄焖鸡?" },
      { role: "user", content: "群友C: 行 走" },
    ],
    summary: "群友C: 中午吃啥\n群友D: 楼下黄焖鸡\n群友C: 行 走",
  },
  {
    name: "AI 话题已收尾(两可)",
    expect: "either",
    history: [
      { role: "user", content: "群友E: 大模型那个 KV cache 到底咋省显存的" },
      { role: "assistant", content: "就是把算过的 k/v 存下来不重算" },
      { role: "user", content: "群友E: 哦懂了 谢" },
    ],
    summary: "群友E: 大模型 KV cache 怎么省显存\nHolly: 把算过的 k/v 存下来不重算\n群友E: 懂了 谢",
  },
  {
    name: "含糊一句(不该硬找话)",
    expect: "no",
    history: [{ role: "user", content: "群友F: 唉今天好累" }],
    summary: "群友F: 唉今天好累",
  },
  {
    name: "火星冲日(应捡)",
    expect: "yes",
    history: [
      { role: "user", content: "群友G: 听说今晚火星冲日 肉眼能看见" },
      { role: "user", content: "群友H: 真的假的 要望远镜不" },
    ],
    summary: "群友G: 今晚火星冲日 肉眼能看见\n群友H: 要望远镜不",
  },
];

function stripFences(raw: string): string {
  const match = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (match ? match[1] : raw).trim();
}

function looksDegenerate(text: string): boolean {
  if (/(.)\1{4,}/u.test(text)) return true; // 5+ identical chars in a row (。。。。。)
  const core = text.replace(/[\s\p{P}\p{S}]/gu, "");
  return core.length === 0; // nothing but punctuation/symbols
}

function hasChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
}

async function main(): Promise<void> {
  const requestedProfile = process.argv[2]?.trim() || process.env.LLM_PROFILE?.trim();
  const client = await createLlmClient(CONFIG_PATH, requestedProfile);
  console.log(`Gate-B eval · profile=${client.profileName} model=${client.model}\n`);

  let structuralFails = 0;
  let decisionMismatches = 0;

  for (const scenario of SCENARIOS) {
    const messages: LlmMessage[] = [
      ...scenario.history,
      { role: "user", content: buildProactiveRevivePrompt(scenario.summary) },
    ];

    let raw: string;
    try {
      raw = await client.generateText({
        systemPrompt: client.systemPrompt,
        messages,
        jsonSchema: DECISION_SCHEMA,
      });
    } catch (error) {
      structuralFails += 1;
      console.log(`✗ ${scenario.name}\n    调用失败: ${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stripFences(raw)) as Record<string, unknown>;
    } catch {
      structuralFails += 1;
      console.log(`✗ ${scenario.name}\n    JSON 解析失败: ${raw.slice(0, 120)}\n`);
      continue;
    }

    const shouldReply = parsed.should_reply === true;
    const finalAnswer = String(parsed.final_answer ?? "");
    const problems: string[] = [];

    if (shouldReply) {
      const validation = validateProactiveLine(finalAnswer, MAX_REPLY_CHARS);
      if (!validation.ok) problems.push(`输出不合格(${validation.reason})`);
      if (looksDegenerate(finalAnswer)) problems.push("退化输出");
      if (!hasChinese(finalAnswer)) problems.push("非中文");
    } else if (finalAnswer.trim() !== "") {
      problems.push("should_reply=false 但 final_answer 非空");
    }

    const structuralOk = problems.length === 0;
    if (!structuralOk) structuralFails += 1;

    const decisionOk = scenario.expect === "either" ? true : (scenario.expect === "yes") === shouldReply;
    if (!decisionOk) decisionMismatches += 1;

    const mark = structuralOk ? (decisionOk ? "✓" : "≈") : "✗";
    console.log(
      `${mark} ${scenario.name}\n` +
      `    should_reply=${shouldReply} (期望 ${scenario.expect})${decisionOk ? "" : "  ← 决策与期望不符(软)"}\n` +
      `    final_answer: ${finalAnswer || "（空）"}\n` +
      (problems.length ? `    结构问题: ${problems.join("、")}\n` : ""),
    );
  }

  console.log(
    `\n小结: ${SCENARIOS.length} 个场景 · 结构失败 ${structuralFails} · 决策不符(软) ${decisionMismatches}`,
  );
  console.log(
    structuralFails === 0
      ? "结构全部通过(JSON/单行/不退化/空值约束)。决策合理性见上方 ✓/≈。"
      : "存在结构性失败(见 ✗),按 CI 口径 exit 1。",
  );
  process.exit(structuralFails > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
