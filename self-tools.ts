import type { LlmToolUseBlock } from "./llm-client.js";

// 她自己的事：记下一件事、写一篇东西。和 qq-tools 里那六个不同——那些是「用 QQ 客户端」，
// 这些跟谁在说话无关，是她自己要做的。
//
// 为什么内容由她自己写，而不是工具去生成：这两件事以前各自是一次独立的 LLM 调用
// （reflectMemory / composeArchive），autonomy 判断先选中动作，再起一次调用问「写什么」。
// 做成工具之后那一次调用就没有了——她在动手的这一轮里直接把 content 填进参数。省的不只是
// 一次调用：那次调用有自己的提示词和自己的上下文，写出来的东西和她此刻在想的事之间隔着
// 一层；现在没有这一层。
//
// 落盘的形状一个字没动，仍旧是 writeMemory / writeArchive 那两条既有路径（记忆进日志加向量
// 库，作品进 archive/）。这里只负责把她填的参数递过去。

export type SelfToolDeps = {
  /** 写一条内部记忆。topic 是题目，content 是正文。 */
  writeMemory: (input: { topic: string; content: string; reason: string }) => Promise<void>;
  /** 写一篇文章或一首诗。 */
  writeArchive: (input: {
    kind: "article" | "poem";
    title: string;
    content: string;
    reason: string;
  }) => Promise<void>;
};

export const SELF_SUBTOOL_NAMES = ["write_memory", "write_archive"] as const;

function ok(payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, ...payload });
}

function refuse(error: string, note: string): string {
  return JSON.stringify({ ok: false, error, note });
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function createSelfToolRunner(
  deps: SelfToolDeps,
): (call: LlmToolUseBlock) => Promise<string> {
  return async (call: LlmToolUseBlock): Promise<string> => {
    switch (call.name) {
      case "write_memory": {
        const topic = readText(call.input.topic);
        const content = readText(call.input.content);
        if (!topic) return refuse("missing topic", "topic 要一个短题目，方便以后认出这条记忆。");
        if (!content) return refuse("missing content", "content 是记忆正文，不能空。");
        await deps.writeMemory({
          topic,
          content,
          // reason 只进日志，不进她的上下文。以前由 reflectMemory 那次调用产出，现在没有
          // 那一步了，就在这里写死一句说明来源——她已经在参数里表达过想记什么了，不必再
          // 逼她多填一个字段解释自己。
          reason: "她自己要记下来的",
        });
        return ok();
      }

      case "write_archive": {
        const kind = call.input.kind === "poem" ? "poem" : "article";
        const title = readText(call.input.title);
        const content = readText(call.input.content);
        if (!title) return refuse("missing title", "title 要一个标题。");
        if (!content) return refuse("missing content", "content 是正文，不能空。");
        await deps.writeArchive({ kind, title, content, reason: "她自己想写的" });
        return ok();
      }

      default:
        return refuse(`unknown subtool ${call.name}`, "这个 runner 只认她自己的那两个子工具。");
    }
  };
}
