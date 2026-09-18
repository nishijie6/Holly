import assert from "node:assert/strict";
import test from "node:test";

import { decideFocus } from "../focus-policy.js";

// 夺焦这条线现在只认一件事：这条消息里有没有结构上叫到她。身份（私聊、管理员）2026-09-19
// 起不再夺焦，所以判定的输入只剩消息正文——「这是谁发的」根本传不进来了，下面的用例也就
// 无从伪造它，这正是想要的性质。
//
// 两边的错都钉在这里：该夺焦却没夺，有人叫她她不应；不该夺焦却夺了，她被群里的闲聊从一场
// 真正的对话里拽走。

const BOT = "10000002";
const at = (rawMessage: string | null) => decideFocus({ rawMessage }, BOT);

test("点出来的 at 段夺焦", () => {
  assert.deepEqual(at(`[CQ:at,qq=${BOT}] 来看看这个`), { foreground: true, reason: "at-mention" });
});

test("@ 的是别人就不夺焦", () => {
  assert.equal(at("[CQ:at,qq=10000004] 你怎么看").foreground, false);
});

test("qq 号只是以她的号开头，不算", () => {
  // \b 挡住 "100000029" 被读成她。
  assert.equal(at(`[CQ:at,qq=${BOT}9] hi`).foreground, false);
});

test("手打的 @holly 夺焦", () => {
  assert.deepEqual(at("@holly 你怎么看"), { foreground: true, reason: "at-mention" });
});

test("手打她的号也夺焦", () => {
  assert.equal(at(`@${BOT} 在吗`).foreground, true);
});

test("手打的 @ 不分大小写", () => {
  assert.equal(at("@Holly 在吗").foreground, true);
});

test("被谈论不等于被叫到", () => {
  // 宽松的读法——正文里出现这个名字就算——等于任何群靠聊她就能把她从别处拽走。
  assert.deepEqual(at("holly 昨天说的那个事挺有意思"), { foreground: false, reason: "ambient" });
  assert.equal(at("我觉得 Holly 的回复越来越像人了").foreground, false);
});

test("普通群聊是横幅", () => {
  assert.deepEqual(at("今天好冷"), { foreground: false, reason: "ambient" });
});

test("正文为 null 时是 ambient，不是崩溃", () => {
  assert.deepEqual(at(null), { foreground: false, reason: "ambient" });
});

test("没配她的 QQ 号时，只有手打的 @holly 还认", () => {
  const noBot = (rawMessage: string) => decideFocus({ rawMessage }, null);
  assert.equal(noBot("@holly 在吗").foreground, true);
  assert.equal(noBot(`[CQ:at,qq=${BOT}] hi`).foreground, false);
});

// 这条钉的是那次有意的改动本身：私聊里说一句正常的话，不再因为「这是私聊」而夺焦。
// 她照样看得见——那条消息会以通知的形式到达——但开不开是她自己的判断。
test("身份不再夺焦：一句没有 @ 的话，无论谁发的都是横幅", () => {
  assert.deepEqual(at("在吗"), { foreground: false, reason: "ambient" });
  assert.deepEqual(at("重启一下"), { foreground: false, reason: "ambient" });
});
