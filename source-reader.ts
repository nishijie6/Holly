import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";

// Holly 读自己源码的那道闸。
//
// 她就跑在这份代码上，被问起「你为什么会这样」的时候，凭印象编不如去读一眼。但同一个目录里
// 还躺着 .env、logs/（完整聊天记录）、data/（SQLite）和 archive/（她自己的作品），所以这里
// 是白名单而不是黑名单：只认源码和文档那几种扩展名，只在仓库根以内，点开头的一律不给。
// config.yaml 也不给——它是被 Git 忽略的本地配置，包含账号、端点和凭据。
//
// 读到的内容会进 ledger 并永久留在上下文里，所以单次读有字符上限：她该读的是某一处究竟怎么
// 写的，不是把整份 main.ts 搬进脑子。
//
// 但这个上限管的是「一次给多少」，不该等于「总共能看到多少」。main.ts 有三十多万字符，只给
// 开头那一截，等于这个工具对她最想弄明白的那个文件形同不存在。所以读文件带一个字符偏移量，
// 截断处顺带告诉她文件多长、这次给的是哪一段、接着读该填什么 offset——她于是能带着问题往后
// 翻，而每一轮注入的量还是那个上限。代价照旧由上下文承担：翻一段就多占一段，永远不会退回去，
// 所以 prompts/qq-tools-help.md 里让她带着要找的东西翻，而不是从头翻到尾。

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

// 一次最多给多少字符。按 context-budget.ts 的估算口径，8000 字符的源码约合 2800–4000
// token，调大就是让她每读一次多占这么多永久上下文；调小则同一个文件要多翻几轮，每轮都得
// 再过一遍工具调用。有了 offset 之后这个数只决定单次粒度，不再是她能看到的全部。
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

export async function readSourceEntry(
  root: string,
  rawPath: string,
  offset = 0,
): Promise<SourceReadResult> {
  const classified = classifySourcePath(rawPath);
  if (!classified.ok) {
    return { ok: false, reason: classified.reason };
  }

  // offset 填坏了（负数、小数、NaN）就当从头读：打回去只会让她再猜一轮，而从头读至少是
  // 个有意义的结果。真正要打回的只有「已经越过文件结尾」，见下面——那种情况给一段空文本，
  // 等于骗她说文件到此为止。
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;

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
  // 目录不认 offset：清单在 MAX_DIRECTORY_ENTRIES 之内本来就是完整的，没有「后面还有」
  // 这回事，而 offset 是字符偏移，对条目列表也切不出有意义的第二页。带着上一次的 offset
  // 来列目录因此不算错，安静地当 0 处理就好。
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
  if (start > 0 && start >= raw.length) {
    return {
      ok: false,
      reason: `${classified.relativePath} 一共只有 ${raw.length} 个字符，offset=${start} 已经越过结尾了。`,
    };
  }

  const end = Math.min(raw.length, start + MAX_FILE_CHARS);
  // 头一行标明这是哪一段，是因为从中间截出来的文本看上去跟文件开头一模一样；整份都给得下
  // 的时候不标，免得给每个短文件都加一句废话。末尾那句是翻页的唯一入口——她不会去猜下一个
  // offset，得有人把它算好递过去。
  const span = start === 0 && end === raw.length
    ? ""
    : `（第 ${start + 1}–${end} 个字符，共 ${raw.length}）`;
  const more = end < raw.length
    ? `\n……（后面还有 ${raw.length - end} 个字符，接着读用 offset=${end}）`
    : "";
  return {
    ok: true,
    kind: "file",
    path: classified.relativePath,
    text: `[源码] ${classified.relativePath}${span}\n${raw.slice(start, end)}${more}`,
  };
}
