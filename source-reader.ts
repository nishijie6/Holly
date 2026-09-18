import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";

// Holly 读自己源码的那道闸。
//
// 她就跑在这份代码上，被问起「你为什么会这样」的时候，凭印象编不如去读一眼。但同一个目录里
// 还躺着 .env、logs/（完整聊天记录）、data/（SQLite）和 archive/（她自己的作品），所以这里
// 是白名单而不是黑名单：只认源码和文档那几种扩展名，只在仓库根以内，点开头的一律不给。
// config.yaml 也不给——它有 access_token 字段，现在是空的，以后未必。
//
// 读到的内容会进 ledger 并永久留在上下文里，所以单个文件有字符上限：她该读的是某一处究竟怎么
// 写的，不是把整份 main.ts 搬进脑子。

export type SourceReadResult =
  | { ok: true; kind: "file" | "directory"; path: string; text: string }
  | { ok: false; reason: string };

const READABLE_EXTENSIONS = new Set([".ts", ".js", ".cjs", ".mjs", ".md", ".json", ".py"]);

// 运行时数据、依赖和构建产物。既不是「她的代码」，又大又敏感。
const DENIED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "logs",
  "data",
  "archive",
  "vendor",
  "__pycache__",
]);

const DENIED_FILES = new Set(["config.yaml", "package-lock.json"]);

const MAX_FILE_CHARS = 8000;
const MAX_DIRECTORY_ENTRIES = 200;

/** 纯路径判断，不碰磁盘：能不能读，先看路径本身答不答应。 */
export function classifySourcePath(
  rawPath: string,
): { ok: true; relativePath: string } | { ok: false; reason: string } {
  const trimmed = rawPath.trim();
  if (isAbsolute(trimmed)) {
    return { ok: false, reason: "只能用仓库里的相对路径，比如 qq-tools.ts。" };
  }
  const normalized = normalize(trimmed === "" ? "." : trimmed).replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  for (const segment of segments) {
    if (segment === "..") {
      return { ok: false, reason: "不能往仓库外面走。" };
    }
    if (segment.startsWith(".")) {
      return { ok: false, reason: "点开头的文件和目录（.env、.git、.claude 这些）读不到。" };
    }
    if (DENIED_DIRECTORIES.has(segment)) {
      return { ok: false, reason: `${segment}/ 读不到：那是运行时数据、依赖或构建产物，不是源码。` };
    }
  }
  const last = segments[segments.length - 1];
  if (last !== undefined && DENIED_FILES.has(last)) {
    return { ok: false, reason: `${last} 读不到：里面可能有凭据。` };
  }
  return { ok: true, relativePath: segments.join("/") };
}

function renderDirectory(relativePath: string, names: readonly string[]): string {
  const shown = names.slice(0, MAX_DIRECTORY_ENTRIES);
  const rest = names.length - shown.length;
  return [
    `[目录] ${relativePath || "."}`,
    ...shown,
    ...(rest > 0 ? [`……还有 ${rest} 项`] : []),
  ].join("\n");
}

export async function readSourceEntry(root: string, rawPath: string): Promise<SourceReadResult> {
  const classified = classifySourcePath(rawPath);
  if (!classified.ok) {
    return { ok: false, reason: classified.reason };
  }

  // 走 realpath 再比一次：白名单挡的是路径长相，符号链接挡的是它真正指向哪里。
  const rootReal = await realpath(root).catch(() => resolve(root));
  const target = classified.relativePath ? join(rootReal, classified.relativePath) : rootReal;
  let targetReal: string;
  try {
    targetReal = await realpath(target);
  } catch {
    return {
      ok: false,
      reason: `没有这个路径：${classified.relativePath || "."}。path 传空字符串可以先看看仓库根目录有什么。`,
    };
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
    return { ok: false, reason: "这个路径指到仓库外面去了，读不到。" };
  }

  const info = await stat(targetReal);
  if (info.isDirectory()) {
    const entries = await readdir(targetReal, { withFileTypes: true });
    const names = entries
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => !(entry.isDirectory() && DENIED_DIRECTORIES.has(entry.name)))
      .filter((entry) => !(entry.isFile() && DENIED_FILES.has(entry.name)))
      .filter((entry) => entry.isDirectory() || READABLE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    return {
      ok: true,
      kind: "directory",
      path: classified.relativePath,
      text: renderDirectory(classified.relativePath, names),
    };
  }
  if (!info.isFile()) {
    return { ok: false, reason: "这不是一个普通文件。" };
  }

  const extension = extname(targetReal).toLowerCase();
  if (!READABLE_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      reason: `只读得了源码和文档（${[...READABLE_EXTENSIONS].join("、")}），这个文件不在其中。`,
    };
  }

  const raw = await readFile(targetReal, "utf-8");
  const clipped = raw.length > MAX_FILE_CHARS
    ? `${raw.slice(0, MAX_FILE_CHARS)}\n……（这个文件太长，只给了前 ${MAX_FILE_CHARS} 个字符）`
    : raw;
  return {
    ok: true,
    kind: "file",
    path: classified.relativePath,
    text: `[源码] ${classified.relativePath}\n${clipped}`,
  };
}
