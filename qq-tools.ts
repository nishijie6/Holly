import type { LlmToolDefinition, LlmToolUseBlock } from "./llm-client.js";

// The three tools that make "one screen at a time" real, modelled on kagami's
// QQ app: list_conversations reads the roster without moving anything,
// open_conversation moves the focus and shows what is there, send_message talks
// to whatever the focus currently is.
//
// Focus lives outside the model. The model asks to move it; this module is the
// only thing that does. That is what makes send_message safe to expose with no
// target argument: the model cannot address a conversation it has not opened,
// so a hallucinated group id cannot become a misdelivered message.
//
// 但这只防住了一半。模型没法对从没打开过的会话说话，却可以对几轮之前打开、焦点一直
// 停在那儿的会话说话：后台通知按设计不移动焦点，模型读完 A 群的通知、没先打开 A 就
// 发，话就进了 B 群。2026-09-10 20000003 群的复读「今天真热啊」就是这样发进了
// 20000001。所以一个 runner 只管一轮，并记住这一轮是被哪个会话唤起的：焦点不在它
// 身上、本轮又没打开过任何会话时拒发，让模型先把目标打开。本轮里主动打开别的会话再
// 说话照常放行——那是有意换群接话，不是焦点过期。

export type ConversationSummary = {
  id: string;
  name: string;
  unread: number;
  lastMessage: string;
  lastAt: string | null;
};

export type QqToolDeps = {
  listConversations: () => Promise<ConversationSummary[]>;
  /** Recent messages for one conversation, already rendered for reading. */
  readConversation: (id: string) => Promise<string[] | null>;
  sendToConversation: (id: string, message: string) => Promise<string | null>;
  getFocus: () => string | null;
  setFocus: (id: string) => void;
  /**
   * Whether sending is currently allowed at all (read-only / offline modes).
   * Checked here so a refusal reaches the model as a tool result it can reason
   * about, instead of an exception that ends the turn.
   */
  canSend: () => { allowed: boolean; reason: string };
  /**
   * 唤起这一轮的会话 id——前台被找的、或后台通知来自的那个会话。send_message 靠它
   * 识别过期焦点，见文件头。null 表示这一轮不是被某个会话唤起的，不做这项检查。
   */
  roundConversationId: string | null;
};

export const QQ_TOOL_DEFINITIONS: readonly LlmToolDefinition[] = [
  {
    name: "list_conversations",
    description:
      "列出所有 QQ 会话（群聊与私聊）及各自的未读数和最后一条消息。只读，不改变你当前打开的会话。",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "open_conversation",
    description:
      "打开一个 QQ 会话，看它的最近消息，并把它设为当前会话；之后 send_message 就发给这个会话。id 必须取自 list_conversations，不要自己编。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: '会话 id，取自 list_conversations。群聊是纯数字（如 "20000001"），私聊是 "private:<QQ号>"。',
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      "向当前打开的会话发一条消息。发之前必须先用 open_conversation 打开目标会话——没有目标参数，发送对象就是当前会话。",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "要发送的消息正文" } },
      required: ["message"],
      additionalProperties: false,
    },
  },
];

function ok(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...payload });
}

// A refusal is data the model should reason about, not an exception. Every
// failure mode here names what to do next, because the alternative is the model
// retrying the same broken call until the round ceiling cuts it off.
function refuse(error: string, note: string): string {
  return JSON.stringify({ ok: false, error, note });
}

// runner 的寿命是一轮：openedThisRound 只在这一轮里有意义，所以调用方每轮都要新建
// 一个。跨轮复用的话，上一轮的一次打开会一直放行后面每一轮的过期焦点。
export function createQqToolRunner(deps: QqToolDeps): (call: LlmToolUseBlock) => Promise<string> {
  let openedThisRound = false;
  return async (call: LlmToolUseBlock): Promise<string> => {
    switch (call.name) {
      case "list_conversations": {
        const conversations = await deps.listConversations();
        return ok({ current: deps.getFocus(), conversations });
      }

      case "open_conversation": {
        const id = typeof call.input.id === "string" ? call.input.id.trim() : "";
        if (!id) {
          return refuse("missing id", "先用 list_conversations 拿到会话 id。");
        }
        const recent = await deps.readConversation(id);
        if (recent === null) {
          return refuse("会话不存在", "先用 list_conversations 看列表拿正确的 id。");
        }
        deps.setFocus(id);
        openedThisRound = true;
        return ok({ id, current: id, recent });
      }

      case "send_message": {
        const message = typeof call.input.message === "string" ? call.input.message.trim() : "";
        if (!message) {
          return refuse("empty message", "message 不能为空。");
        }
        const focus = deps.getFocus();
        if (!focus) {
          return refuse("没有打开的会话", "先用 open_conversation 打开目标会话再发送。");
        }
        // 排在 canSend 前面：发错群是模型当场就能改的错，先告诉它；只读之类的抑制是
        // 环境状态，目标改对之后自然还会遇到。
        const round = deps.roundConversationId;
        if (round && focus !== round && !openedThisRound) {
          return refuse(
            "焦点不在这一轮的会话上",
            `你当前打开的是 ${focus}，这一轮的消息却来自 ${round}。要回 ${round} 就先 open_conversation 打开它；确实想在 ${focus} 说话，也先 open_conversation 把它重新打开。`,
          );
        }
        const sending = deps.canSend();
        if (!sending.allowed) {
          return refuse("发送被抑制", sending.reason);
        }
        const messageId = await deps.sendToConversation(focus, message);
        return ok({ conversationId: focus, messageId });
      }

      default:
        return refuse(`unknown tool ${call.name}`, "只能使用列出的工具。");
    }
  };
}
