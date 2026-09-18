import assert from "node:assert/strict";
import test from "node:test";

import { classifySourcePath, readSourceEntry } from "../source-reader.js";

// 直接拿真实仓库当素材：npm test 就是从仓库根跑起来的，而这道闸要防的恰恰是「这个目录里
// 除了源码还有什么」，用临时目录搭出来的假仓库反而验不到真正要紧的那几条。
const ROOT = process.cwd();

test("读得到自己的源码", async () => {
  const result = await readSourceEntry(ROOT, "qq-tools.ts");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.kind, "file");
  assert.match(result.text, /list_conversations/);
});

test("传目录就列出里面有什么，传空字符串看仓库根", async () => {
  const dir = await readSourceEntry(ROOT, "test");
  assert.equal(dir.ok, true);
  if (!dir.ok) return;
  assert.equal(dir.kind, "directory");
  assert.match(dir.text, /qq-tools\.test\.ts/);

  const root = await readSourceEntry(ROOT, "");
  assert.equal(root.ok, true);
  if (!root.ok) return;
  assert.match(root.text, /main\.ts/);
  // 清单本身也是信息：列出来就等于告诉她「这儿有东西可读」，所以运行时数据和凭据连名字都不该出现。
  for (const hidden of ["node_modules", "logs", "data", "archive", "config.yaml", ".env"]) {
    assert.equal(root.text.includes(hidden), false, `${hidden} 不该出现在清单里`);
  }
});

test("凭据、日志、运行时数据和仓库外的路径一律读不到", async () => {
  for (const path of [
    ".env",
    "config.yaml",
    "logs/monitor.jsonl",
    "data/holly.db",
    "node_modules/ws/package.json",
    "dist/main.js",
    "../Holly/.env",
    "/etc/passwd",
    ".claude/settings.local.json",
  ]) {
    const result = await readSourceEntry(ROOT, path);
    assert.equal(result.ok, false, `${path} 该被拒`);
  }
});

test("路径判断不碰磁盘，单独也站得住", () => {
  assert.deepEqual(classifySourcePath("qq-tools.ts"), { ok: true, relativePath: "qq-tools.ts" });
  assert.deepEqual(classifySourcePath(""), { ok: true, relativePath: "" });
  assert.deepEqual(classifySourcePath("test/qq-tools.test.ts"), { ok: true, relativePath: "test/qq-tools.test.ts" });
  assert.equal(classifySourcePath("../secrets").ok, false);
  assert.equal(classifySourcePath("logs/x.log").ok, false);
  assert.equal(classifySourcePath("/etc/passwd").ok, false);
});

test("太长的文件只给开头一截，免得整份搬进上下文", async () => {
  const result = await readSourceEntry(ROOT, "main.ts");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.text, /只给了前/);
  assert.ok(result.text.length < 9000, "截断之后不该还是整份文件");
});
