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

test("太长的文件一次只给一段，免得整份搬进上下文", async () => {
  const result = await readSourceEntry(ROOT, "main.ts");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.text.length < 9000, "截断之后不该还是整份文件");
  // 截断处必须把下一个 offset 算好给她。她不会去猜，而猜错一次的代价是白读一段重复的正文，
  // 且那段重复永远留在上下文里。
  assert.match(result.text, /接着读用 offset=8000/);
});

test("offset 翻到文件后面去，而不是每次都从头读", async () => {
  const head = await readSourceEntry(ROOT, "main.ts");
  const next = await readSourceEntry(ROOT, "main.ts", 8000);
  assert.equal(head.ok, true);
  assert.equal(next.ok, true);
  if (!head.ok || !next.ok) return;
  assert.notEqual(head.text, next.text);
  // 从中间截出来的文本看上去跟文件开头没有区别，所以这一段得自报是哪一段。
  assert.match(next.text, /第 8001–16000 个字符/);
  assert.match(next.text, /接着读用 offset=16000/);
});

test("offset 越过结尾要明说：给一段空文本等于告诉她这里就是结尾", async () => {
  const result = await readSourceEntry(ROOT, "source-reader.ts", 10_000_000);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /越过结尾/);
});

test("坏 offset 当从头读，不为难她重来一轮", async () => {
  for (const offset of [-5, Number.NaN, 3.7]) {
    const result = await readSourceEntry(ROOT, "qq-tools.ts", offset);
    assert.equal(result.ok, true, `offset=${offset} 该退回从头读而不是报错`);
  }
});

test("目录不认 offset：清单本来就是完整的，没有「后面还有」这回事", async () => {
  const first = await readSourceEntry(ROOT, "test");
  const withOffset = await readSourceEntry(ROOT, "test", 5000);
  assert.equal(first.ok, true);
  assert.equal(withOffset.ok, true);
  if (!first.ok || !withOffset.ok) return;
  assert.equal(first.text, withOffset.text);
});
