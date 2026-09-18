import assert from "node:assert/strict";
import test from "node:test";

import {
  FOCUS_LOOP_PROMPT,
  buildFocusForegroundInjection,
  buildFocusNotificationInjection,
  buildFocusSystemPrompt,
  type FocusInjectionInput,
} from "../focus-prompt.js";
import { MODEL_DECISION_PROMPT } from "../decision-prompt.js";
import { QQ_SUBTOOL_NAMES } from "../qq-tools.js";
import { loadPromptText } from "../prompt-text.js";

// 这里钉住的是两条不能再犯的错。
//
// 一是协议本身:tool loop 里模型直接写出来的文字到不了群里,所以协议必须把
// send_message 说成唯一的发送途径,而且绝对不能掺进老管线那套「返回 JSON」的话。
// 一旦有人图省事把 MODEL_DECISION_PROMPT 接回来,Holly 会安静地一句话都不发,
// 线上表现是「模型好像不想说话」,极难往协议上想。
//
// 二是通知里必须有真的消息内容。后台路径不推时间线,通知是模型唯一的线索;老管线
// 的元数据块搬过来就只剩 current_time 和 group_id,模型无从判断该不该点开。

const baseInput: FocusInjectionInput = {
  conversationLabel: "群20000001",
  openConversationLabel: "群20000001",
  reason: "ambient",
  currentTime: "2026-09-07 14:30 星期日",
  recent: [],
  batch: [],
  adminUserIds: [],
};

test("协议把 send_message 说成唯一的发送途径", () => {
  assert.match(FOCUS_LOOP_PROMPT, /只有一条路[:：]\s*调用 send_message/u);
  assert.match(FOCUS_LOOP_PROMPT, /不会被发送到任何地方/u);
});

test("协议不含任何 JSON 决策字段", () => {
  for (const leaked of ["should_reply", "final_answer", "thinking_process", "need_search", "search_query"]) {
    assert.equal(FOCUS_LOOP_PROMPT.includes(leaked), false, `focus 协议里不该出现 ${leaked}`);
  }
});

test("focus 协议和决策协议是两份不同的东西", () => {
  assert.notEqual(FOCUS_LOOP_PROMPT, MODEL_DECISION_PROMPT);
  // 老协议要求「Return JSON only」,这句话进了 tool loop 就是让 Holly 闭嘴。
  assert.equal(FOCUS_LOOP_PROMPT.includes("Return JSON only"), false);
});

// 协议是 system prompt，和工具定义一样按字节计入稳定前缀。清单搬去 help 就是为了让「加一个
// 子工具」不再碰前缀，所以这里守一份白名单。
//
// 名单上这三个不是清单的残留，是行为规则：发送只有 send_message 这一条路、open_conversation
// 会改变 send_message 的目标、拿不准的事实去 search_web 查而不是编。这些讲的是她该怎么行事，
// 本来就该在协议里，而且加第七个子工具不会动它们。
//
// 反过来，哪天这条测试因为一个新名字失败了，那不一定是写错了——它在说「你正在往稳定前缀里
// 加东西」。确认那条规则真的非在协议里不可，再把名字加进这份白名单。
const SUBTOOLS_ALLOWED_IN_PROMPT = new Set(["send_message", "open_conversation", "search_web"]);

test("协议只保留带行为规则的子工具名，清单本身指向 help", () => {
  for (const name of QQ_SUBTOOL_NAMES) {
    if (SUBTOOLS_ALLOWED_IN_PROMPT.has(name)) continue;
    assert.ok(!FOCUS_LOOP_PROMPT.includes(name), `协议里不该再出现 ${name}——它只是清单的一项`);
  }
  // 枚举块整体消失：留着它，等于清单从没搬走。
  assert.ok(!FOCUS_LOOP_PROMPT.includes("你有六个工具"));
  assert.match(FOCUS_LOOP_PROMPT, /help/u);
  assert.match(FOCUS_LOOP_PROMPT, /invoke/u);
});

// 清单搬走了，但「有哪些工具」这件事总得有地方写清楚，否则她 help 完还是不知道能干什么。
test("六个子工具在 help 文档里交代清楚", () => {
  const help = loadPromptText("qq-tools-help");
  for (const name of QQ_SUBTOOL_NAMES) {
    assert.ok(help.includes(name), `help 里该讲清 ${name}`);
  }
});

test("协议交代了不调工具就是不做事", () => {
  assert.match(FOCUS_LOOP_PROMPT, /不调任何工具就结束这一轮/u);
});

// 这条以前是反过来的：协议写着「你没有联网搜索工具」,她照着跟人说自己查不了。加了
// search_web 之后那句话必须消失,否则她会守着工具声称自己不能联网。
test("协议让她去搜,而不是声称自己不能联网", () => {
  assert.equal(FOCUS_LOOP_PROMPT.includes("没有联网搜索工具"), false);
  assert.equal(FOCUS_LOOP_PROMPT.includes("你搜不了"), false);
  // 搜索期间先说一句话是这个工具的一半价值。这句怎么用随子工具清单一起搬去了 help，
  // 但它必须还在某处写着——否则她会默默开搜，让等的人干看十几秒。
  assert.match(loadPromptText("qq-tools-help"), /saying/u);
});

test("system prompt 是 persona 接协议,persona 在前", () => {
  const prompt = buildFocusSystemPrompt("你是 Holly。");
  assert.ok(prompt.startsWith("你是 Holly。"));
  assert.ok(prompt.endsWith(FOCUS_LOOP_PROMPT));
});

test("前台注入带上焦点原因、最近消息和本轮元数据", () => {
  const text = buildFocusForegroundInjection({
    ...baseInput,
    reason: "at-mention",
    recent: ["[09-07 14:29] [张三(111)] @holly 在吗", "[09-07 14:30] 在的"],
    batch: [{ senderLabel: "[张三(111)]", text: "@holly 在吗" }],
  });
  assert.match(text, /^\[焦点已切到 群20000001——有人在群里 @ 了你\]/u);
  assert.ok(text.includes("[09-07 14:29] [张三(111)] @holly 在吗"));
  assert.ok(text.includes("current_time: 2026-09-07 14:30 星期日"));
  // recent 里已经有这批消息了,再列一遍会让模型把同一句话当成两件事。
  assert.equal(text.split("@holly 在吗").length - 1, 1);
});

test("焦点原因翻成中文,英文枚举不进模型视野", () => {
  const text = buildFocusForegroundInjection({ ...baseInput, reason: "private-chat" });
  assert.equal(text.includes("private-chat"), false);
  assert.match(text, /这是私聊/u);
});

test("后台通知带真实消息内容,不只是元数据", () => {
  const text = buildFocusNotificationInjection({
    ...baseInput,
    batch: [
      { senderLabel: "[张三(111)]", text: "今天好热" },
      { senderLabel: "[李四(222)]", text: "确实" },
    ],
  });
  assert.ok(text.includes("今天好热"), "通知必须让模型看到消息内容");
  assert.ok(text.includes("确实"));
  assert.match(text, /有 2 条新消息/u);
  assert.match(text, /焦点没动/u);
  // 这是老 bug 的回归钉:通知曾经是一段扫描元数据被截到 200 字符。
  assert.equal(text.includes("Scheduled reply scan"), false);
});

test("通知只列最近几条,其余折叠成一句并指向 open_conversation", () => {
  const text = buildFocusNotificationInjection({
    ...baseInput,
    batch: Array.from({ length: 7 }, (_, index) => ({
      senderLabel: `[群友${index}(${index})]`,
      text: `第${index}句`,
    })),
  });
  assert.match(text, /有 7 条新消息/u);
  assert.equal(text.includes("第0句"), false);
  assert.ok(text.includes("第6句"), "最新的那条必须在");
  assert.match(text, /前面还有 3 条没列出来/u);
  assert.ok(text.includes("open_conversation"));
});

test("过长的单条消息被截断,不让一条刷屏消息撑爆通知", () => {
  const text = buildFocusNotificationInjection({
    ...baseInput,
    batch: [{ senderLabel: null, text: "啊".repeat(300) }],
  });
  assert.ok(text.includes("…"));
  assert.ok(text.length < 200);
});

test("空白消息不占通知的位置", () => {
  const text = buildFocusNotificationInjection({
    ...baseInput,
    batch: [{ senderLabel: "[张三(111)]", text: "   " }, { senderLabel: "[李四(222)]", text: "在吗" }],
  });
  assert.equal(text.includes("[张三(111)]"), false);
  assert.ok(text.includes("在吗"));
});

test("管理员消息在元数据里点名,并说清不许假装做完", () => {
  const text = buildFocusForegroundInjection({
    ...baseInput,
    reason: "admin-forced",
    adminUserIds: ["10000001", "10000001"],
    batch: [{ senderLabel: "[主人(10000001)]", text: "重启一下" }],
  });
  assert.match(text, /管理员消息,发送人 user_id: 10000001/u);
  // 去重:同一个人发三条不该在元数据里出现三次。
  assert.equal(text.split("10000001").length - 1, 1);
  assert.match(FOCUS_LOOP_PROMPT, /管理员的消息必须给出一个明确答复/u);
  assert.match(FOCUS_LOOP_PROMPT, /不要假装已经做了/u);
});

test("受理了的改进代码命令带 job_id,并禁止说已经跑完", () => {
  const text = buildFocusForegroundInjection({
    ...baseInput,
    reason: "admin-forced",
    adminUserIds: ["10000001"],
    codeJobId: "job-42",
    batch: [{ senderLabel: "[主人(10000001)]", text: "/改进代码 修个 bug" }],
  });
  assert.match(text, /job_id=job-42/u);
  assert.match(text, /不要说已经跑完或已经生效/u);
});

test("没启动起来的改进代码命令把原因原样交给模型", () => {
  const text = buildFocusForegroundInjection({
    ...baseInput,
    reason: "admin-forced",
    adminUserIds: ["10000001"],
    codeJobNote: "工作区不干净",
    batch: [{ senderLabel: "[主人(10000001)]", text: "/改进代码 改点东西" }],
  });
  assert.match(text, /工作区不干净/u);
  assert.equal(text.includes("job_id="), false);
});

test("不是管理员的批次,元数据里没有管理员那几行", () => {
  const text = buildFocusNotificationInjection({
    ...baseInput,
    batch: [{ senderLabel: "[张三(111)]", text: "hello" }],
  });
  assert.equal(text.includes("管理员"), false);
  assert.equal(text.includes("job_id"), false);
});

// 2026-09-10 串群的另一半原因:元数据里只有一个 conversation: 群20000003,模型把
// 「通知来自哪」读成了「我现在在哪」。这两件事必须分开写。
test("通知把消息来自哪、当前打开的是哪分开写", () => {
  const text = buildFocusNotificationInjection({
    ...baseInput,
    conversationLabel: "群20000003",
    openConversationLabel: "群20000001",
    batch: [{ senderLabel: "[小王(10000005)]", text: "今天真热啊" }],
  });
  assert.ok(text.includes("消息来自: 群20000003"));
  assert.ok(text.includes("当前打开: 群20000001"));
  assert.equal(text.includes("conversation:"), false, "含糊的 conversation 字段不能回来");
});

test("还没打开过任何会话时,当前打开写成「无」而不是留空", () => {
  const text = buildFocusNotificationInjection({ ...baseInput, openConversationLabel: null });
  assert.ok(text.includes("当前打开: 无"));
});
