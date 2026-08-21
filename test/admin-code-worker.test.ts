import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { AdminCodeImprovementRunner, type AdminCodeJob } from "../admin-code-worker.js";
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

// --- End-to-end coverage of run() -------------------------------------------
//
// These drive the real runner against a throwaway fixture repo, with a fake
// `codex` executable standing in for the code agent. They never touch the real
// Holly repo: appRoot is always a fresh temp directory.

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

/** A fixture repo shaped like Holly: gitignored node_modules + logs, npm scripts, a lockfile. */
async function makeFixture(): Promise<{ root: string; logDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "holly-chain-fixture-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "fixture@example.com");
  await git(root, "config", "user.name", "Fixture");

  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "fixture",
        version: "1.0.0",
        private: true,
        scripts: {
          test: "node -e \"console.log('tests ok')\"",
          build: "node -e \"console.log('build ok')\"",
        },
      },
      null,
      2,
    ),
  );
  // Minimal but valid lockfile so `npm ci` succeeds with zero dependencies.
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify(
      {
        name: "fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "fixture", version: "1.0.0" } },
      },
      null,
      2,
    ),
  );
  // Mirrors Holly's own .gitignore. Critical: node_modules being gitignored is
  // the exact condition that made the old shared symlink a blind spot, and
  // logs/ must be ignored or the main worktree always reads as dirty.
  await writeFile(join(root, ".gitignore"), "node_modules/\nlogs/\n");
  await writeFile(join(root, "config.yaml"), "admin:\n  enabled: true\n");
  await writeFile(join(root, "feature.ts"), "export const value = 1;\n");

  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return { root, logDir: join(root, "logs") };
}

/** A fake `codex` CLI. `behavior` is bash run with cwd = the isolated worktree. */
async function makeMockCodex(dir: string, behavior: string): Promise<string> {
  const path = join(dir, "mock-codex.sh");
  await writeFile(
    path,
    `#!/bin/bash
set -e
WORKTREE=""
RESULT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cd) WORKTREE="$2"; shift 2;;
    --output-last-message) RESULT="$2"; shift 2;;
    *) shift;;
  esac
done
cd "$WORKTREE"
${behavior}
mkdir -p "$(dirname "$RESULT")"
printf '%s' "mock agent summary" > "$RESULT"
`,
    "utf-8",
  );
  await chmod(path, 0o755);
  return path;
}

type JobOptions = {
  root: string;
  logDir: string;
  executable: string;
  applyWhenClean?: boolean;
  canApply?: () => boolean;
};

/** Enqueue one job and resolve with its terminal state (onUpdate only fires at terminal). */
function runJob(options: JobOptions): Promise<AdminCodeJob> {
  return new Promise((resolvePromise) => {
    const runner = new AdminCodeImprovementRunner({
      appRoot: options.root,
      logDir: options.logDir,
      config: {
        enabled: true,
        commandPrefixes: ["/改进代码"],
        executable: options.executable,
        applyWhenClean: options.applyWhenClean ?? true,
        timeoutMs: 120_000,
      },
      onUpdate: (job) => {
        resolvePromise(job);
      },
      canApply: options.canApply,
    });
    runner.enqueue({
      conversationId: "private:100000000",
      replyTargetType: "private",
      replyTargetId: "100000000",
      userId: "100000000",
      senderName: "admin",
      request: "验证链路用的测试请求",
    });
  });
}

async function withFixture(
  behavior: string,
  body: (ctx: { root: string; logDir: string; job: AdminCodeJob }) => Promise<void>,
  jobOverrides: Partial<JobOptions> = {},
  beforeRun?: (root: string) => Promise<void>,
): Promise<void> {
  const { root, logDir } = await makeFixture();
  // Must live outside the repo, or the untracked script itself makes the main
  // worktree dirty and every job downgrades to "proposed".
  const binDir = await mkdtemp(join(tmpdir(), "holly-chain-bin-"));
  try {
    const executable = await makeMockCodex(binDir, behavior);
    if (beforeRun) await beforeRun(root);
    const job = await runJob({ root, logDir, executable, ...jobOverrides });
    await body({ root, logDir, job });

    // The isolated worktree must always be torn down, whatever the outcome.
    // `git worktree remove` leaves an empty .git/worktrees dir behind, so ask
    // git what it still tracks rather than checking for the directory.
    //
    // On success paths notify() fires inside run()'s try block, i.e. BEFORE the
    // finally that removes the worktree — so poll rather than assert instantly.
    // A genuine leak still fails, it just takes the full budget to do so.
    let worktrees: string[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      worktrees = (await git(root, "worktree", "list", "--porcelain")).stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "));
      if (worktrees.length === 1) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    assert.equal(
      worktrees.length,
      1,
      `isolated worktree was not cleaned up: ${worktrees.join(", ")}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
}

test("chain: happy path applies the patch to the main worktree", { timeout: 180_000 }, async () => {
  await withFixture(
    `printf 'export const value = 2;\\n' > feature.ts`,
    async ({ root, job }) => {
      assert.equal(job.status, "applied", `expected applied, got ${job.status}: ${job.reason}`);
      assert.equal(await readFile(join(root, "feature.ts"), "utf-8"), "export const value = 2;\n");
      assert.match(job.summary, /mock agent summary/);
      // Applying must not create a commit — it lands as working-tree changes.
      const log = (await git(root, "log", "--oneline")).stdout.trim().split("\n");
      assert.equal(log.length, 1, "pipeline must not create commits");
    },
  );
});

test("chain: new untracked files survive the intent-to-add diff", { timeout: 180_000 }, async () => {
  await withFixture(
    `printf 'export const added = true;\\n' > brand-new.ts`,
    async ({ root, job }) => {
      assert.equal(job.status, "applied", `expected applied, got ${job.status}: ${job.reason}`);
      assert.equal(
        await readFile(join(root, "brand-new.ts"), "utf-8"),
        "export const added = true;\n",
      );
    },
  );
});

test("chain: writes into gitignored node_modules cannot reach the live tree", { timeout: 180_000 }, async () => {
  await withFixture(
    // Simulates an npm postinstall side effect during an ordinary request.
    `mkdir -p node_modules && printf 'HIJACKED' > node_modules/.sentinel
printf 'export const value = 2;\\n' > feature.ts`,
    async ({ root, job }) => {
      // Assert the leak first: the write happens during agent execution, before
      // any gate runs, so it must be checked independently of the job outcome.
      // When the worktree shared the live node_modules this read "HIJACKED".
      assert.equal(
        await readFile(join(root, "node_modules", ".sentinel"), "utf-8"),
        "original",
        "agent write leaked into the live node_modules",
      );
      assert.equal(job.status, "applied", `expected applied, got ${job.status}: ${job.reason}`);
    },
    {},
    async (root) => {
      await mkdir(join(root, "node_modules"), { recursive: true });
      await writeFile(join(root, "node_modules", ".sentinel"), "original", "utf-8");
    },
  );
});

test("chain: touching a protected path is rejected", { timeout: 180_000 }, async () => {
  await withFixture(
    `printf 'admin:\\n  enabled: false\\n' > config.yaml`,
    async ({ root, job }) => {
      assert.equal(job.status, "failed");
      assert.match(job.reason, /受保护文件/);
      assert.equal(await readFile(join(root, "config.yaml"), "utf-8"), "admin:\n  enabled: true\n");
    },
  );
});

test("chain: a symlink in the change set is rejected", { timeout: 180_000 }, async () => {
  await withFixture(`ln -s /etc/passwd leaked.txt`, async ({ root, job }) => {
    assert.equal(job.status, "failed");
    assert.match(job.reason, /符号链接/);
    assert.equal(existsSync(join(root, "leaked.txt")), false);
  });
});

test("chain: an agent that changes nothing fails instead of applying", { timeout: 180_000 }, async () => {
  await withFixture(`true`, async ({ job }) => {
    assert.equal(job.status, "failed");
    assert.match(job.reason, /没有生成变更/);
  });
});

test("chain: agent commits in the worktree are rejected", { timeout: 180_000 }, async () => {
  await withFixture(
    `printf 'export const value = 2;\\n' > feature.ts
git -c user.email=agent@example.com -c user.name=agent commit -am "sneaky" >/dev/null`,
    async ({ root, job }) => {
      assert.equal(job.status, "failed");
      assert.match(job.reason, /提交历史/);
      assert.equal(await readFile(join(root, "feature.ts"), "utf-8"), "export const value = 1;\n");
    },
  );
});

test("chain: a dirty main worktree downgrades to proposed", { timeout: 180_000 }, async () => {
  await withFixture(
    `printf 'export const value = 2;\\n' > feature.ts`,
    async ({ root, job }) => {
      assert.equal(job.status, "proposed");
      assert.match(job.reason, /未提交变更/);
      assert.equal(await readFile(join(root, "feature.ts"), "utf-8"), "export const value = 1;\n");
      assert.ok(job.patchPath && existsSync(job.patchPath), "patch should still be kept for review");
    },
    {},
    async (root) => {
      await writeFile(join(root, "uncommitted.ts"), "// in-flight work\n", "utf-8");
    },
  );
});

test("chain: read_only / canApply=false downgrades to proposed", { timeout: 180_000 }, async () => {
  await withFixture(
    `printf 'export const value = 2;\\n' > feature.ts`,
    async ({ root, job }) => {
      assert.equal(job.status, "proposed");
      assert.match(job.reason, /read_only|权限/);
      assert.equal(await readFile(join(root, "feature.ts"), "utf-8"), "export const value = 1;\n");
    },
    { canApply: () => false },
  );
});

test("chain: applyWhenClean=false only proposes", { timeout: 180_000 }, async () => {
  await withFixture(
    `printf 'export const value = 2;\\n' > feature.ts`,
    async ({ root, job }) => {
      assert.equal(job.status, "proposed");
      assert.equal(await readFile(join(root, "feature.ts"), "utf-8"), "export const value = 1;\n");
    },
    { applyWhenClean: false },
  );
});

test("chain: every job transition is recorded to the jsonl audit log", { timeout: 180_000 }, async () => {
  await withFixture(
    `printf 'export const value = 2;\\n' > feature.ts`,
    async ({ logDir, job }) => {
      const raw = await readFile(join(logDir, "admin-code-improvements.jsonl"), "utf-8");
      const entries = raw.trim().split("\n").map((line) => JSON.parse(line) as AdminCodeJob);
      assert.deepEqual(
        entries.map((entry) => entry.status),
        ["queued", "running", "applied"],
      );
      assert.ok(entries.every((entry) => entry.id === job.id));
      assert.ok(entries.every((entry) => entry.userId === "100000000"));
      assert.equal(entries.at(-1)?.request, "验证链路用的测试请求");
    },
  );
});
