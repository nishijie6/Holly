import type { RecentAutonomyAction, WorldTopicStatus } from "./autonomy-engine.js";

export type AutonomyContextTopic = WorldTopicStatus & {
  /** 已经按当前配置解析过的会话 ID；空列表就是没有分享目标。 */
  targetConversationIds: readonly string[];
};

export type AutonomyContextInput = {
  nowMs: number;
  lastAutonomousMessageAt?: number;
  lastWorldObservationAt?: number;
  lastWorldObservationShareAt?: number;
  recentActions: readonly RecentAutonomyAction[];
  worldObservationEnabled: boolean;
  topics: readonly AutonomyContextTopic[];
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const RECENT_ACTION_LIMIT = 6;
const TOPIC_LIMIT = 8;
const TARGET_LIMIT = 3;

function knownTime(at: number | undefined, nowMs: number): number {
  return typeof at === "number" && Number.isFinite(at) && at > 0 && at <= nowMs ? at : 0;
}

function ageLabel(at: number, nowMs: number): string {
  if (at === 0) return "未知";
  const ageMs = nowMs - at;
  if (ageMs < MINUTE_MS) return "刚刚";
  if (ageMs < HOUR_MS) return `${Math.floor(ageMs / MINUTE_MS)} 分钟前`;
  if (ageMs < DAY_MS) return `${Math.floor(ageMs / HOUR_MS)} 小时前`;
  return `${Math.floor(ageMs / DAY_MS)} 天前`;
}

function shortText(value: string, limit: number): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** 给念头的选择和执行共用的近况；只使用传入事实，不抓取、不选择动作，也不设发送配额。 */
export function buildAutonomyContext(input: AutonomyContextInput): string {
  const lastMessageAt = knownTime(input.lastAutonomousMessageAt, input.nowMs);
  const lastObservationAt = knownTime(input.lastWorldObservationAt, input.nowMs);
  const lastShareAt = knownTime(input.lastWorldObservationShareAt, input.nowMs);
  const lastSocialAt = Math.max(lastMessageAt, lastShareAt);
  const lastOutwardAt = Math.max(lastObservationAt, lastSocialAt);
  const actions = input.recentActions
    .map((action) => ({ ...action, at: knownTime(action.at, input.nowMs) }))
    .sort((a, b) => b.at - a.at);
  const streak = actions.filter((action) => action.at > lastOutwardAt).length;
  const lines = [
    "自主近况（仅据留存记录）：",
    `上次真实自主发送：${ageLabel(lastMessageAt, input.nowMs)}${lastMessageAt === 0 ? "（未留存，不代表从未发过）" : ""}；世界观察：${ageLabel(lastObservationAt, input.nowMs)}；观察分享：${ageLabel(lastShareAt, input.nowMs)}。`,
    `创作连续段：留存记录中，自最近一次已知观察或对外发送后连续创作 ${streak} 次${lastOutwardAt === 0 ? "（观察或发送时间未知）" : ""}。`,
    "最近创作（最新在前）：",
  ];
  for (const action of actions.slice(0, RECENT_ACTION_LIMIT)) {
    const kind = action.kind === "memory_reflection" ? "记忆反思" : "归档写作";
    lines.push(`- ${ageLabel(action.at, input.nowMs)}：${kind}《${shortText(action.title, 80) || "无题"}》`);
  }
  if (actions.length === 0) lines.push("- 暂无留存的创作记录。");
  if (actions.length > RECENT_ACTION_LIMIT) lines.push(`- 另有 ${actions.length - RECENT_ACTION_LIMIT} 条较早创作未展开。`);

  lines.push(`世界观察当前${input.worldObservationEnabled ? "开启" : "关闭"}；配置话题及通常分享目标：`);
  for (const topic of input.topics.slice(0, TOPIC_LIMIT)) {
    const targets = [...new Set(topic.targetConversationIds.map((id) => id.trim()).filter(Boolean))];
    const shownTargets = targets.slice(0, TARGET_LIMIT).map((id) => shortText(id, 80));
    const targetLabel = targets.length === 0
      ? "未配置分享目标"
      : `通常会话 ${shownTargets.join("、")}${targets.length > TARGET_LIMIT ? `（另有 ${targets.length - TARGET_LIMIT} 个）` : ""}`;
    lines.push(`- ${shortText(topic.topic, 48) || "未命名话题"}：上次 ${ageLabel(knownTime(topic.lastAt, input.nowMs), input.nowMs)}；结果 ${shortText(topic.outcome, 80) || "未知"}；${targetLabel}`);
  }
  if (input.topics.length === 0) lines.push("- 未配置观察话题。");
  if (input.topics.length > TOPIC_LIMIT) lines.push(`- 另有 ${input.topics.length - TOPIC_LIMIT} 个话题未展开。`);

  // 只在已有一段重复创作、且没有近期分享记录时给一个可忽略的提醒；这是上下文，不是发送闸。
  if (streak >= 3 && (lastSocialAt === 0 || input.nowMs - lastSocialAt >= 6 * HOUR_MS)) {
    const observationOption = input.worldObservationEnabled && input.topics.length > 0
      ? "观察一个配置话题，或"
      : "";
    lines.push(`连续创作后，也可以考虑${observationOption}打开熟悉的会话看看；没有合适内容时可以不发。`);
  }
  return lines.join("\n");
}
