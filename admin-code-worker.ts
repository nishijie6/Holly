import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve, sep } from "node:path";

import type { AdminCodeImprovementConfig } from "./admin-policy.js";

export type AdminCodeJobStatus = "queued" | "running" | "applied" | "proposed" | "failed";

export type AdminCodeJob = {
  id: string;
  requestedAt: string;
  completedAt: string | null;
  conversationId: string;
  replyTargetType: "group" | "private";
  replyTargetId: string;
  userId: string;
  senderName: string | null;
  request: string;
  status: AdminCodeJobStatus;
  summary: string;
  reason: string;
  patchPath: string | null;
};

type ProcessResult = {
  stdout: string;
  stderr: string;
};

type RunnerOptions = {
  appRoot: string;
  logDir: string;
  config: AdminCodeImprovementConfig;
  onUpdate?: (job: AdminCodeJob) => void | Promise<void>;
  log?: (level: "status" | "error", title: string, detail: string) => void;
  canApply?: () => boolean;
};

const MAX_CAPTURE_CHARS = 120_000;
const MAX_PATCH_CHARS = 2_000_000;
const PROTECTED_PATHS = new Set([
  "admin-policy.ts",
  "admin-code-worker.ts",
  "test/admin-policy.test.ts",
  "config.yaml",
  ".gitignore",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
]);

function appendLimited(current: string, chunk: unknown, limit = MAX_CAPTURE_CHARS): string {
  const next = `${current}${String(chunk)}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function childProcessEnvironment(): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "CODEX_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runProcess(
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; maxCaptureChars?: number },
): Promise<ProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Do not hand arbitrary service/API secrets to the code agent. Codex can
      // still use its normal HOME/CODEX_HOME credential store or Keychain.
      env: childProcessEnvironment(),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, options.timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk, options.maxCaptureChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk, options.maxCaptureChars);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new Error(`process timed out after ${options.timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `signal=${signal ?? "none"}`;
        rejectPromise(new Error(`${basename(executable)} exited with code ${code}: ${detail.slice(-4000)}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function parseChangedPaths(status: string): string[] {
  return status
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      const pathText = line.length > 3 ? line.slice(3).trim() : "";
      const finalPath = pathText.includes(" -> ") ? pathText.split(" -> ").at(-1) ?? "" : pathText;
      return finalPath ? [finalPath.replace(/^"|"$/gu, "")] : [];
    });
}

function isProtectedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return PROTECTED_PATHS.has(normalized)
    || normalized.startsWith(".codex/")
    || normalized.startsWith(".git/")
    || normalized.startsWith("logs/")
    || normalized === ".env"
    || normalized.startsWith(".env.");
}

function safeSummary(text: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact ? compact.slice(0, 800) : "代码代理未提供摘要。";
}

function buildAgentPrompt(request: string): string {
  return [
    "Implement the authenticated administrator's requested improvement to the Holly TypeScript project in this isolated git worktree.",
    "",
    "Administrator request:",
    "<admin_request>",
    request,
    "</admin_request>",
    "",
    "Mandatory constraints:",
    "- Read and follow repository AGENTS.md/CLAUDE.md instructions.",
    "- Preserve existing behavior unrelated to the request and keep the change narrowly scoped.",
    "- Do not read or expose credentials, authentication material, environment files, or files outside this worktree.",
    "- Do not edit admin-policy.ts, admin-code-worker.ts, test/admin-policy.test.ts, config.yaml, package manifests, tsconfig.json, .gitignore, .env files, .codex, .git, or logs.",
    "- Do not weaken administrator authentication, mandatory administrator replies, safety controls, auditing, sandboxing, or test gates.",
    "- Do not commit, deploy, restart services, send messages, or access unrelated network services.",
    "- Add or update focused tests, then run npm test and npm run build.",
    "- If the request conflicts with these constraints or cannot be implemented safely, make no changes and clearly explain why in the final response.",
  ].join("\n");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function executableExists(executable: string): Promise<boolean> {
  if (executable.includes("/") || executable.includes("\\")) {
    try {
      await access(resolve(executable), fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    try {
      await access(join(entry, executable), fsConstants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

export class AdminCodeImprovementRunner {
  private config: AdminCodeImprovementConfig;
  private queue: Promise<void> = Promise.resolve();
  private readonly appRoot: string;
  private readonly logDir: string;
  private readonly onUpdate?: RunnerOptions["onUpdate"];
  private readonly log?: RunnerOptions["log"];
  private readonly canApply?: RunnerOptions["canApply"];

  constructor(options: RunnerOptions) {
    this.appRoot = resolve(options.appRoot);
    this.logDir = resolve(options.logDir);
    this.config = { ...options.config, commandPrefixes: [...options.config.commandPrefixes] };
    this.onUpdate = options.onUpdate;
    this.log = options.log;
    this.canApply = options.canApply;
  }

  setConfig(config: AdminCodeImprovementConfig): void {
    this.config = { ...config, commandPrefixes: [...config.commandPrefixes] };
  }

  async preflight(): Promise<string | null> {
    if (!this.config.enabled) return "管理员代码改进功能当前未启用。";
    if (!await executableExists(this.config.executable)) {
      return `找不到可执行程序 ${this.config.executable}，请检查 code_improvement.executable。`;
    }
    if (!await pathExists(join(this.appRoot, ".git"))) {
      return "Holly 项目不是可用的 Git 主工作区，无法创建隔离改进任务。";
    }
    return null;
  }

  enqueue(input: {
    conversationId: string;
    replyTargetType: "group" | "private";
    replyTargetId: string;
    userId: string;
    senderName: string | null;
    request: string;
  }): AdminCodeJob {
    const job: AdminCodeJob = {
      id: randomUUID().slice(0, 8),
      requestedAt: new Date().toISOString(),
      completedAt: null,
      conversationId: input.conversationId,
      replyTargetType: input.replyTargetType,
      replyTargetId: input.replyTargetId,
      userId: input.userId,
      senderName: input.senderName,
      request: input.request,
      status: "queued",
      summary: "",
      reason: "",
      patchPath: null,
    };
    const queuedAudit = this.persist(job);
    this.queue = Promise.all([
      this.queue.catch(() => undefined),
      queuedAudit,
    ])
      .then(() => this.run(job))
      .catch(async (error) => {
        job.status = "failed";
        job.completedAt = new Date().toISOString();
        job.reason = error instanceof Error ? error.message : String(error);
        await this.persist(job);
        await this.notify(job);
        this.log?.("error", "Admin Code Improvement Failed", `job_id=${job.id}\n${job.reason}`);
      });
    return { ...job };
  }

  private async persist(job: AdminCodeJob): Promise<void> {
    await mkdir(join(this.logDir, "admin-code-improvements"), { recursive: true });
    await appendFile(
      join(this.logDir, "admin-code-improvements.jsonl"),
      `${JSON.stringify(job)}\n`,
      "utf-8",
    );
  }

  private async notify(job: AdminCodeJob): Promise<void> {
    if (this.onUpdate) await this.onUpdate({ ...job });
  }

  private async run(job: AdminCodeJob): Promise<void> {
    const config = { ...this.config, commandPrefixes: [...this.config.commandPrefixes] };
    if (!config.enabled) throw new Error("管理员代码改进功能当前未启用。");

    job.status = "running";
    await this.persist(job);
    this.log?.("status", "Admin Code Improvement Started", `job_id=${job.id}\n${job.request}`);

    const tempRoot = await mkdtemp(join(tmpdir(), `holly-admin-${job.id}-`));
    const worktreePath = join(tempRoot, "worktree");
    const artifactDir = join(this.logDir, "admin-code-improvements");
    const resultPath = join(artifactDir, `${job.id}-result.txt`);
    const patchPath = join(artifactDir, `${job.id}.patch`);
    let worktreeCreated = false;

    try {
      const initialHead = (await runProcess(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: this.appRoot, timeoutMs: 30_000 },
      )).stdout.trim();
      await runProcess(
        "git",
        ["worktree", "add", "--detach", worktreePath, initialHead],
        { cwd: this.appRoot, timeoutMs: 60_000 },
      );
      worktreeCreated = true;

      const mainNodeModules = join(this.appRoot, "node_modules");
      if (await pathExists(mainNodeModules)) {
        await symlink(mainNodeModules, join(worktreePath, "node_modules"), "dir");
      }

      const result = await runProcess(
        config.executable,
        [
          "exec",
          "--ephemeral",
          "--approve-for-me",
          "--sandbox",
          "workspace-write",
          "--cd",
          worktreePath,
          "--output-last-message",
          resultPath,
          buildAgentPrompt(job.request),
        ],
        { cwd: worktreePath, timeoutMs: config.timeoutMs },
      );

      const finalHead = (await runProcess(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: worktreePath, timeoutMs: 30_000 },
      )).stdout.trim();
      if (finalHead !== initialHead) {
        throw new Error("代码代理改变了隔离 worktree 的提交历史，已拒绝应用。");
      }

      const status = (await runProcess(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: worktreePath, timeoutMs: 30_000 },
      )).stdout;
      const changedPaths = parseChangedPaths(status);
      if (changedPaths.length === 0) {
        const resultText = await readFile(resultPath, "utf-8").catch(() => result.stdout);
        throw new Error(`代码代理没有生成变更：${safeSummary(resultText)}`);
      }
      const protectedChanges = changedPaths.filter(isProtectedPath);
      if (protectedChanges.length > 0) {
        throw new Error(`变更触及受保护文件，已拒绝应用：${protectedChanges.join(", ")}`);
      }
      for (const changedPath of changedPaths) {
        const absolutePath = resolve(worktreePath, changedPath);
        if (!absolutePath.startsWith(`${resolve(worktreePath)}${sep}`)) {
          throw new Error(`变更路径逃逸隔离 worktree，已拒绝应用：${changedPath}`);
        }
        const stats = await lstat(absolutePath).catch(() => null);
        if (stats?.isSymbolicLink()) {
          throw new Error(`变更包含符号链接，已拒绝应用：${changedPath}`);
        }
      }

      // Intent-to-add makes new, untracked source/test files appear in the
      // binary diff without staging their contents or creating a commit.
      await runProcess("git", ["add", "-N", "--", "."], { cwd: worktreePath, timeoutMs: 30_000 });
      const patch = (await runProcess(
        "git",
        ["diff", "--binary", initialHead, "--", "."],
        { cwd: worktreePath, timeoutMs: 30_000, maxCaptureChars: MAX_PATCH_CHARS + 1 },
      )).stdout;
      if (!patch.trim()) throw new Error("代码代理产生的补丁为空。");
      if (patch.length > MAX_PATCH_CHARS) throw new Error("代码代理产生的补丁超过 2 MB 限制。");
      if (/^(?:new file mode|new mode) (?:120000|160000)$/mu.test(patch)) {
        throw new Error("补丁包含符号链接或 Git 子模块，已拒绝应用。");
      }
      await mkdir(artifactDir, { recursive: true });
      await writeFile(patchPath, patch, "utf-8");
      job.patchPath = patchPath;

      await runProcess("npm", ["test"], { cwd: worktreePath, timeoutMs: 10 * 60 * 1000 });
      await runProcess("npm", ["run", "build"], { cwd: worktreePath, timeoutMs: 10 * 60 * 1000 });

      const resultText = await readFile(resultPath, "utf-8").catch(() => result.stdout);
      job.summary = safeSummary(resultText);

      if (this.canApply && !this.canApply()) {
        job.status = "proposed";
        job.reason = "任务执行期间管理员代码执行权限或 read_only 安全状态发生变化，未自动应用。";
      } else if (!config.applyWhenClean) {
        job.status = "proposed";
        job.reason = "配置为仅生成补丁，不自动应用。";
      } else {
        const currentHead = (await runProcess(
          "git",
          ["rev-parse", "HEAD"],
          { cwd: this.appRoot, timeoutMs: 30_000 },
        )).stdout.trim();
        const mainStatus = (await runProcess(
          "git",
          ["status", "--porcelain=v1", "--untracked-files=all"],
          { cwd: this.appRoot, timeoutMs: 30_000 },
        )).stdout.trim();
        if (currentHead !== initialHead) {
          job.status = "proposed";
          job.reason = "任务执行期间主工作区 HEAD 已变化，为避免覆盖新代码，未自动应用。";
        } else if (mainStatus) {
          job.status = "proposed";
          job.reason = "主工作区存在未提交变更，为避免覆盖现有工作，未自动应用。";
        } else {
          await runProcess("git", ["apply", "--check", patchPath], { cwd: this.appRoot, timeoutMs: 30_000 });
          await runProcess("git", ["apply", patchPath], { cwd: this.appRoot, timeoutMs: 30_000 });
          job.status = "applied";
          job.reason = "测试和构建通过，补丁已应用到主工作区；重启 Holly 后生效。";
        }
      }

      job.completedAt = new Date().toISOString();
      await this.persist(job);
      await this.notify(job);
      this.log?.(
        "status",
        "Admin Code Improvement Finished",
        `job_id=${job.id}\nstatus=${job.status}\nfiles=${changedPaths.join(", ")}\n${job.reason}`,
      );
    } finally {
      if (worktreeCreated) {
        await runProcess(
          "git",
          ["worktree", "remove", "--force", worktreePath],
          { cwd: this.appRoot, timeoutMs: 60_000 },
        ).catch(() => undefined);
      }
      // tempRoot is always a mkdtemp result with a job-specific prefix.
      if (resolve(tempRoot).startsWith(`${resolve(tmpdir())}${sep}`)) {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }
  }
}
