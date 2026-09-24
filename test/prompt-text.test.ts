import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadPromptText, renderPromptText } from "../prompt-text.js";

// 文件以换行结尾是正常的文本写法，但拼进请求的字符串不能带着它。这两段以前由
// .join("\n") 生成、末尾没有换行；多出一个字节就是一次缓存前缀失效，而且是那种
// 看 diff 看不出来的失效。
test("文件末尾的换行不会跟着进 prompt", () => {
  for (const name of ["focus-loop", "model-decision"]) {
    const loaded = loadPromptText(name);
    const raw = readFileSync(join(process.cwd(), "prompts", `${name}.md`), "utf-8");

    assert.ok(raw.endsWith("\n"), `prompts/${name}.md 应当以换行结尾`);
    assert.ok(!loaded.endsWith("\n"), `${name} 载入后不该以换行结尾`);
    assert.equal(loaded, raw.replace(/\n+$/, ""));
  }
});

// 这是她的人格和协议。拿不到就不该带着空 prompt 爬起来装作没事——那样她会变成一个
// 没有设定的裸模型，还照样往群里说话。
test("读不到的 prompt 直接抛，不静默退成空串", () => {
  assert.throws(
    () => loadPromptText("这个文件不存在"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /这个文件不存在/);
      // 错误信息要带路径：一个人半夜看到这条日志，得知道去哪儿找。
      assert.match(error.message, /prompts/);
      return true;
    },
  );
});

test("同一段 prompt 只从磁盘读一次", () => {
  const first = loadPromptText("focus-loop");
  const second = loadPromptText("focus-loop");
  assert.equal(first, second);
});

// 念头那一路没有群消息带进来的 current_time，时间只能靠这两段模板自己带。占位符被谁顺手删掉，
// 她就又回到「早上还以为是昨晚」。末行必须是本轮元数据：账本压缩靠首尾两行认出这一条。
test("念头两段模板都带上现在的时间，注入末行是本轮元数据", () => {
  const now = "2026-09-23 09:00 星期三";
  const voice = renderPromptText("inner-voice", { now });
  assert.ok(voice.includes(now));
  assert.doesNotMatch(voice, /\{\{/);

  const injection = renderPromptText("inner-thought-injection", { thought: "去看看数学", now, open: "群20000002" });
  assert.doesNotMatch(injection, /\{\{/);
  assert.equal(injection.split("\n").at(-1), `[本轮 current_time: ${now} | 当前打开: 群20000002]`);
});
