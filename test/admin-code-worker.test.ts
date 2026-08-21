import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AdminCodeImprovementRunner } from "../admin-code-worker.js";
import { parseAdminPolicyConfig } from "../admin-policy.js";

test("code improvement preflight rejects a missing executor", async () => {
  const root = await mkdtemp(join(tmpdir(), "holly-admin-worker-test-"));
  try {
    const config = parseAdminPolicyConfig({
      code_improvement: { executable: join(root, "missing-codex") },
    }).codeImprovement;
    const runner = new AdminCodeImprovementRunner({
      appRoot: root,
      logDir: join(root, "logs"),
      config,
    });
    assert.match(await runner.preflight() ?? "", /找不到可执行程序/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code improvement preflight requires a git main worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "holly-admin-worker-test-"));
  try {
    const config = parseAdminPolicyConfig({
      code_improvement: { executable: process.execPath },
    }).codeImprovement;
    const runner = new AdminCodeImprovementRunner({
      appRoot: root,
      logDir: join(root, "logs"),
      config,
    });
    assert.match(await runner.preflight() ?? "", /不是可用的 Git 主工作区/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
