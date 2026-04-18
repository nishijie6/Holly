import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLlmClient } from "./llm-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = existsSync(join(process.cwd(), "package.json")) ? process.cwd() : __dirname;
const CONFIG_PATH = join(APP_ROOT, "config.yaml");

async function main(): Promise<void> {
  const requestedProfile = process.argv[2]?.trim() || process.env.LLM_PROFILE?.trim();
  const client = await createLlmClient(CONFIG_PATH, requestedProfile);
  const message = await client.generateText({
    messages: [
      { role: "user", content: "你是谁？" },
    ],
  });

  console.log(JSON.stringify({
    profile: client.profileName,
    provider: client.provider,
    model: client.model,
    message,
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
