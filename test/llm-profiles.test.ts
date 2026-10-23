import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listLlmProfiles, resolveLlmProfile, setActiveLlmProfile } from "../llm-client.js";

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
  active: gpt_main
  decision_profile: gpt_decision
  system_prompt: hello
  profiles:
    gpt_main:
      provider: codex
      model: gpt-5.4
    gpt_decision:
      provider: codex
      model: gpt-5.4-mini
`;

test("LLM profile catalog exposes the configured decision profile", async () => {
  await withConfig(profilesYaml, async (path) => {
    const catalog = await listLlmProfiles(path) as Awaited<ReturnType<typeof listLlmProfiles>> & {
      decision?: string;
    };
    assert.equal(catalog.active, "gpt_main");
    assert.equal(catalog.decision, "gpt_decision");
  });
});

test("decision profile defaults to the active profile for backward compatibility", async () => {
  await withConfig(profilesYaml.replace("  decision_profile: gpt_decision\n", ""), async (path) => {
    const catalog = await listLlmProfiles(path) as Awaited<ReturnType<typeof listLlmProfiles>> & {
      decision?: string;
    };
    assert.equal(catalog.decision, "gpt_main");
  });
});

test("an unknown decision profile is rejected during config loading", async () => {
  await withConfig(profilesYaml.replace("decision_profile: gpt_decision", "decision_profile: missing"), async (path) => {
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

for (const provider of ["claude", "anthropic", "openai", "unknown"]) {
  test(`unsupported provider ${provider} is rejected before any request`, async () => {
    await withConfig(profilesYaml.replaceAll("provider: codex", `provider: ${provider}`), async (path) => {
      await assert.rejects(() => listLlmProfiles(path), /unsupported provider/i);
      await assert.rejects(() => resolveLlmProfile(path), /unsupported provider/i);
      await assert.rejects(() => setActiveLlmProfile(path, "gpt_decision"), /unsupported provider/i);
    });
  });
}

for (const model of ["claude-opus-4-7", "o3", "anything", "gpt-bogus"]) {
  test(`unsupported model ${model} is rejected when resolving or switching profiles`, async () => {
    await withConfig(profilesYaml.replaceAll("gpt-5.4", model), async (path) => {
      await assert.rejects(() => listLlmProfiles(path), /unsupported.*model/i);
      await assert.rejects(() => resolveLlmProfile(path), /unsupported.*model/i);
      await assert.rejects(() => setActiveLlmProfile(path, "gpt_decision"), /unsupported.*model/i);
    });
  });
}

test("an unknown active profile is rejected by the catalog and cannot be switched to", async () => {
  await withConfig(profilesYaml.replace("active: gpt_main", "active: missing"), async (path) => {
    await assert.rejects(() => listLlmProfiles(path), /profile 'missing' not found/i);
    await assert.rejects(() => setActiveLlmProfile(path, "missing"), /profile 'missing' not found/i);
  });
});
