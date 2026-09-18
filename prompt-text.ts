import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 进上下文的成句散文，从 prompts/ 下的纯文本读进来。
//
// 为什么搬出 TypeScript：这些文字是写给 Holly 的，不是写给编译器的。留在 .ts 里，改一句
// 语气就得动代码文件，diff 混在逻辑改动里，每行还裹着引号、逗号和转义。挪到纯文本之后，
// 「调她怎么说话」和「改她怎么做事」变成两件分开的事，也就能分开 review。
//
// 为什么不是 .txt 而是 .md：source-reader.ts 的白名单认 .md，不认 .txt。她自己能用
// read_source 读到的东西里，最该包括写给她的这几段话——换成 .txt 就把她挡在门外了。
//
// 为什么同步读、读不到就崩：这是她的人格和协议。拿不到它，进程不该带着一个空 prompt 爬起来
// 装作没事——那样她会变成一个没有设定的裸模型，还照样往群里说话。宁可起不来。
// 与 autonomy 那份「最近写过什么」相反：那个缺了只少几行提示，这个缺了就没有她了。
//
// 路径按本模块自身的位置解析，不看进程 cwd：PM2 用 tsx 直接跑仓库里的源码
// （ecosystem.config.cjs），dist 不参与运行，所以这里和 prompts/ 始终是同级。哪天真改成跑
// dist，第一次加载就会当场抛错，而不是安静地少掉半个 prompt。

const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

const cache = new Map<string, string>();

export function loadPromptText(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }

  const path = join(PROMPT_DIR, `${name}.md`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`prompt "${name}" 读不到（${path}）：${detail}`);
  }

  // 文件以换行结尾是常规写法，但拼进请求的字符串不该带着它——以前这些 prompt 由
  // .join("\n") 生成，末尾没有换行，保持一致才不会平白改动缓存前缀。
  const text = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!text.trim()) {
    throw new Error(`prompt "${name}" 是空的（${path}）`);
  }

  cache.set(name, text);
  return text;
}

/**
 * 带占位符的 prompt：把 {{name}} 换成给定的值。
 *
 * 只做这一件事，不引模板引擎——目前全仓就一个占位符（念头注入里的 thought）。真需要条件和
 * 循环的时候再说，那时候引什么都比现在猜得准。
 *
 * 值里出现 {{...}} 不会被再替换一轮：一次性扫过原文，替换只看模板里的占位符。她写的念头里
 * 要是碰巧有两个花括号，不该被当成模板语法。
 */
export function renderPromptText(name: string, vars: Record<string, string>): string {
  return loadPromptText(name).replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole,
  );
}
