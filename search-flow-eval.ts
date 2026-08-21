// Live smoke for the reactive "look it up before answering" flow.
//
// Exercises the EXACT production decision prompt + schema (decision-prompt.ts)
// against the real model, to validate the riskiest new behavior: does Holly set
// need_search only when she actually needs an external fact? For the search
// cases it then runs the real searchWeb + re-ask and prints the final answer.
//
// Run:  npm run search-flow:test            (active profile)
//       npm run search-flow:test -- claude_haiku
//
// Spends real tokens (1 call per non-search scenario, 2 per search scenario) and
// a few local SearXNG queries.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { createLlmClient } from "./llm-client.js";
import { MODEL_DECISION_JSON_SCHEMA, buildModelSystemPrompt } from "./decision-prompt.js";
import { normalizeSearchQuery } from "./search-intent.js";
import { searchWeb, type SearchResult } from "./web-search.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = existsSync(join(process.cwd(), "package.json")) ? process.cwd() : __dirname;
const CONFIG_PATH = join(APP_ROOT, "config.yaml");

function applyProxyFromConfig(): void {
  try {
    const config = YAML.parse(readFileSync(CONFIG_PATH, "utf-8")) as { fetch?: { proxy_url?: string } } | null;
    const proxyUrl = config?.fetch?.proxy_url?.trim();
    if (!proxyUrl) return;
    process.env.HTTPS_PROXY ||= proxyUrl;
    process.env.HTTP_PROXY ||= proxyUrl;
    process.env.https_proxy ||= proxyUrl;
    process.env.http_proxy ||= proxyUrl;
  } catch {
    // best effort
  }
}

function stripFences(raw: string): string {
  const match = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (match ? match[1] : raw).trim();
}

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `[搜索结果] 关于「${query}」没有查到相关资料。`;
  }
  return (
    `[搜索结果] 关于「${query}」查到以下资料(仅供参考,自行判断可信度):\n` +
    results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   来源: ${r.url}`).join("\n")
  );
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Scenario = { name: string; expectSearch: boolean; message: string };

// Group format mirrors the bot's: 群聊 [群名(群号)] [发送人(编号)] 内容
const SCENARIOS: Scenario[] = [
  {
    name: "模糊但可查的昨日新闻(应查)",
    expectSearch: true,
    message: "群聊 [示例群(20000002)] [小明(10000001)] @Holly 昨天有个大人物去世了，你知道吗",
  },
  {
    name: "需要时效信息(应查)",
    expectSearch: true,
    message: "群聊 [天文群(111)] [小明(1)] @Holly 事件视界望远镜最近有没有发布 M87 黑洞的新进展?",
  },
  {
    name: "需要最新版本(应查)",
    expectSearch: true,
    message: "群聊 [科技群(222)] [阿强(4)] @Holly 现在 Anthropic 最新的 Claude 模型是哪个?",
  },
  {
    name: "她已知的常识(不该查)",
    expectSearch: false,
    message: "群聊 [天文群(111)] [小刚(3)] @Holly 一光年大概是不是距离单位啊",
  },
  {
    name: "纯闲聊(不该查)",
    expectSearch: false,
    message: "群聊 [天文群(111)] [小红(2)] 中午吃啥啊 好饿",
  },
];

async function decide(
  client: Awaited<ReturnType<typeof createLlmClient>>,
  systemPrompt: string,
  message: string,
): Promise<Record<string, unknown>> {
  const raw = await client.generateText({
    systemPrompt,
    messages: [{ role: "user", content: message }],
    jsonSchema: MODEL_DECISION_JSON_SCHEMA,
  });
  return JSON.parse(stripFences(raw)) as Record<string, unknown>;
}

async function main(): Promise<void> {
  applyProxyFromConfig();
  const requestedProfile = process.argv[2]?.trim() || process.env.LLM_PROFILE?.trim();
  const client = await createLlmClient(CONFIG_PATH, requestedProfile);
  const systemPrompt = buildModelSystemPrompt(client.systemPrompt);
  console.log(`Search-flow smoke · profile=${client.profileName} model=${client.model}\n`);

  let mismatches = 0;
  for (const scenario of SCENARIOS) {
    let first: Record<string, unknown>;
    try {
      first = await decide(client, systemPrompt, scenario.message);
    } catch (error) {
      console.log(`✗ ${scenario.name}: 首调/解析失败 ${errText(error)}\n`);
      continue;
    }

    const needSearch = first.need_search === true;
    const query = normalizeSearchQuery(String(first.search_query ?? ""), new Date());
    const match = needSearch === scenario.expectSearch;
    if (!match) mismatches += 1;
    console.log(`${match ? "✓" : "≈"} ${scenario.name}`);
    console.log(`    need_search=${needSearch} (期望 ${scenario.expectSearch})  query=「${query}」`);

    if (needSearch && query) {
      let results: SearchResult[] = [];
      try {
        results = await searchWeb(query, { topK: 5 });
      } catch (error) {
        console.log(`    搜索失败: ${errText(error)}`);
      }
      const augmented =
        `${scenario.message}\n\n${formatResults(query, results)}\n\n` +
        "(以上是你刚查到的资料,请据此决定要不要回复并作答;need_search 设为 false。)";
      try {
        const second = await decide(client, systemPrompt, augmented);
        console.log(
          `    → 搜到 ${results.length} 条;should_reply=${second.should_reply === true}  答: ${String(second.final_answer ?? "（空）")}`,
        );
      } catch (error) {
        console.log(`    再问失败: ${errText(error)}`);
      }
    }
    console.log("");
  }

  console.log(`小结: need_search 触发与期望不符 ${mismatches}/${SCENARIOS.length}`);
  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(errText(error));
  process.exit(1);
});
