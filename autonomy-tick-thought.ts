import type {
  AutonomyCheck,
  AutonomyCheckName,
  AutonomyCheckStatus,
  AutonomyLoopResult,
} from "./autonomy-engine.js";

export type AutonomyTickThought = {
  summary: string;
  outcome: string;
  groupId: string | null;
  finalAnswer: string;
};

// 前三个已经变成她手边的子工具，这个循环不再亲自发起它们；标签留着是因为历史记录里还有
// 旧条目，读出来不该显示成一个裸的英文 key。
const CHECK_LABELS: Record<AutonomyCheckName, string> = {
  world_observation: "世界观察",
  memory_reflection: "记忆反思",
  archive_writing: "归档写作",
  inner_voice: "冒个念头",
  group_proactive: "群聊主动开口",
};

const STATUS_LABELS: Record<AutonomyCheckStatus, string> = {
  disabled: "已关闭",
  waiting: "等待中",
  acted: "已行动",
  no_action: "未行动",
  deferred: "本轮顺延",
};

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function formatWait(nextEligibleAt: number, tickAt: number): string {
  const remainingMs = Math.max(0, nextEligibleAt - tickAt);
  if (remainingMs < 60_000) return "不足 1 分钟后可再次执行";
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `约 ${minutes} 分钟后可再次执行`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `约 ${hours} 小时${remainder ? ` ${remainder} 分钟` : ""}后可再次执行`;
}

function formatCheck(check: AutonomyCheck, tickAt: number): string {
  const wait = check.nextEligibleAt !== null
    ? `；${formatWait(check.nextEligibleAt, tickAt)}`
    : "";
  return `- ${CHECK_LABELS[check.name]}：${STATUS_LABELS[check.status]}——${compact(check.reason, 600)}${wait}`;
}

// 世界观察取消固定间隔以后几乎每轮都可选，模型没选它的时候，这一行每分钟都是同一句「本轮顺延」，
// 不带任何信息，只会把真正有用的明细淹掉——这一轮为什么没去看，「未行动原因」里已经写了。
// 等重试、已行动、已关闭都还有信息量，照常列出。
function shouldListCheck(check: AutonomyCheck): boolean {
  return !(check.name === "world_observation" && check.status === "deferred");
}

function formatProactiveAnswers(result: AutonomyLoopResult): {
  groupId: string | null;
  finalAnswer: string;
} {
  if (result.action.type !== "send_group_message") {
    return { groupId: null, finalAnswer: "" };
  }
  const actions = result.action.actions;
  if (actions.length === 1) {
    return {
      groupId: actions[0].groupKey,
      finalAnswer: actions[0].text,
    };
  }
  return {
    groupId: null,
    finalAnswer: actions
      .map((action) => `群 ${action.groupKey}（${action.mode === "live" ? "已发送" : "影子模式"}）：${action.text}`)
      .join("\n"),
  };
}

export function buildAutonomyTickThought(
  result: AutonomyLoopResult,
  tickAt = Date.now(),
): AutonomyTickThought {
  const action = result.action;
  const lines = ["检查内容：群聊主动开口、冒念头。"];
  let outcome = "idle";

  switch (action.type) {
    case "do_nothing":
      lines.push(
        "本轮结果：未行动。",
        `未行动原因：${action.reason === "autonomy disabled" ? "自主循环已关闭" : compact(action.reason, 900)}`,
      );
      outcome = action.reason === "autonomy disabled" ? "disabled" : "idle";
      break;
    case "inner_thought":
      // 念头本身进的是她的账本，不在这里复述——这条记录只说「冒了」，内容看她随后那一轮。
      lines.push("本轮结果：冒了个念头，接下来做什么看她自己。");
      outcome = "inner_thought";
      break;
    case "send_group_message": {
      const liveCount = action.actions.filter((item) => item.mode === "live").length;
      const shadowCount = action.actions.length - liveCount;
      lines.push(
        `本轮结果：产生 ${action.actions.length} 个主动开口动作（已发送 ${liveCount}，影子模式 ${shadowCount}）。`,
      );
      outcome = liveCount > 0 ? "proactive_live" : "proactive_shadow";
      break;
    }
  }

  lines.push("检查明细：", ...result.checks.filter(shouldListCheck).map((check) => formatCheck(check, tickAt)));
  const answer = formatProactiveAnswers(result);
  return {
    summary: lines.join("\n"),
    outcome,
    groupId: answer.groupId,
    finalAnswer: answer.finalAnswer,
  };
}
