import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listLlmProfiles } from "../llm-client.js";

async function withConfig(
  llmYaml: string,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "holly-llm-profiles-"));
  const path = join(dir, "config.yaml");
  try {
    await writeFile(path, llmYaml, "utf8");
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const profilesYaml = `
llm:
  active: claude_opus
  decision_profile: claude_sonnet
  system_prompt: hello
  profiles:
    claude_opus:
      provider: claude
      model: claude-opus-4-7
    claude_sonnet:
      provider: claude
      model: claude-sonnet-4-6
`;

test("LLM profile catalog exposes the configured decision profile", async () => {
  await withConfig(profilesYaml, async (path) => {
    const catalog = await listLlmProfiles(path) as Awaited<ReturnType<typeof listLlmProfiles>> & {
      decision?: string;
    };
    assert.equal(catalog.active, "claude_opus");
    assert.equal(catalog.decision, "claude_sonnet");
  });
});

test("decision profile defaults to the active profile for backward compatibility", async () => {
  await withConfig(profilesYaml.replace("  decision_profile: claude_sonnet\n", ""), async (path) => {
    const catalog = await listLlmProfiles(path) as Awaited<ReturnType<typeof listLlmProfiles>> & {
      decision?: string;
    };
    assert.equal(catalog.decision, "claude_opus");
  });
});

test("an unknown decision profile is rejected during config loading", async () => {
  await withConfig(profilesYaml.replace("decision_profile: claude_sonnet", "decision_profile: missing"), async (path) => {
    await assert.rejects(() => listLlmProfiles(path), /decision profile 'missing' not found/i);
  });
});

test("a missing local config explains how to create it without creating one implicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "holly-missing-config-"));
  const path = join(dir, "config.yaml");
  try {
    await assert.rejects(() => listLlmProfiles(path), /copy.*config\.example\.yaml.*config\.yaml/i);
    await assert.rejects(() => access(path), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
