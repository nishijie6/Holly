import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";

import { AdminCodeImprovementRunner } from "../admin-code-worker.js";
import { isAdminUserId, parseAdminPolicyConfig } from "../admin-policy.js";
import { forcedQqModeDecision, parseHollyBootstrapConfig } from "../holly-bootstrap.js";
import { listLlmProfiles, setActiveLlmProfile } from "../llm-client.js";
import { createIncomingMessageStore } from "../memory-store.js";
import { parsePrivateChatConfig } from "../private-chat.js";

const EXAMPLE = new URL("../config.example.yaml", import.meta.url);

test("the public example starts offline and grants no administrator or private-chat capabilities", async () => {
  const config = YAML.parse(await readFile(EXAMPLE, "utf8"));
  const bootstrap = parseHollyBootstrapConfig(config.holly_bootstrap);
  assert.equal(forcedQqModeDecision(bootstrap)?.mode, "offline");
  assert.equal(bootstrap.reflectionEnabled, false);
  assert.equal(config.read_only, true);

  // Even an ID supplied through the environment must wait for explicit enablement.
  const admin = parseAdminPolicyConfig(config.admin, "12345678");
  assert.equal(isAdminUserId("12345678", admin), false);
  const runner = new AdminCodeImprovementRunner({
    appRoot: process.cwd(),
    logDir: join(process.cwd(), "logs"),
    config: admin.codeImprovement,
  });
  assert.match(await runner.preflight() ?? "", /未启用/);
  assert.equal(parsePrivateChatConfig(config.private_chat).enabled, false);
  assert.equal(config.autonomy.enabled, false);
  assert.equal(config.proactive.enabled, false);
  assert.equal(config.qdrant.enabled, false);
});

test("a copied example supports local profile writes and SQLite memory without touching the template", async () => {
  const dir = await mkdtemp(join(tmpdir(), "holly-example-config-"));
  const configPath = join(dir, "config.yaml");
  const original = await readFile(EXAMPLE, "utf8");
  try {
    await copyFile(EXAMPLE, configPath);
    const catalog = await listLlmProfiles(configPath);
    assert.ok(catalog.profiles.some((profile) => profile.name === catalog.active));
    const alternative = catalog.profiles.find((profile) => profile.name !== catalog.active);
    assert.ok(alternative);

    const local = YAML.parse(await readFile(configPath, "utf8"));
    local.admin.user_ids = ["12345678"];
    local.napcat.access_token = "test-only-local-token";
    await writeFile(configPath, YAML.stringify(local), "utf8");
    await setActiveLlmProfile(configPath, alternative.name);
    assert.equal((await listLlmProfiles(configPath)).active, alternative.name);
    const saved = YAML.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.admin.user_ids, ["12345678"]);
    assert.equal(saved.napcat.access_token, "test-only-local-token");
    assert.equal(await readFile(EXAMPLE, "utf8"), original);

    assert.equal(saved.database.provider, "sqlite");
    const store = await createIncomingMessageStore(configPath);
    assert.ok(store);
    assert.equal(store.collectionName, "memory_records");
    assert.deepEqual(await store.listRecentMemories({ limit: 1 }), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
