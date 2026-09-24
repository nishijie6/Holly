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
  /**
   * 这一轮是不是被门挡在了门外、压根没问（不应期、夜里、她正忙、连败退避、循环关着）；是的话
   * 给出挡住它的那个原因，数字抹成 #，否则为 null。给 createAutonomyTickThoughtGate 用。
   *
   * 问出去却失败了（冒念头失败）不算被挡：那是一次真实发生的调用，每一次都值得留下。
   */
  holdKey: string | null;
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

// 被挡在门外的那几条分支，引擎报的检查项一律是 waiting（门控、退避）或 disabled（循环关着）；
// 真的问了、失败了，报的是 deferred。拿这个区分，而不是去认原因里的字——文案改了也不会认错。
function isHeldAtGate(result: AutonomyLoopResult): boolean {
  return result.action.type === "do_nothing"
    && result.checks.length > 0
    && result.checks.every((check) => check.status === "waiting" || check.status === "disabled");
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
    // 数字抹掉：退避那句「暂停 9 分钟」下一分钟变成「暂停 8 分钟」，说的仍是同一件事。
    holdKey: isHeldAtGate(result) ? result.action.reason.replace(/\d+/g, "#") : null,
  };
}

/**
 * 决定一次 tick 的结论要不要写进思考历史。返回的函数有状态，一个进程用一个。
 *
 * 这个循环每分钟跑一次，但醒着的时候每五分钟才可能问一次，夜里八个小时一次都不问——于是一天
 * 一千三百来条记录里，九成是「刚问过，还在不应期里」「夜里不起这个念头」这两句原样重复。思考历史
 * 按行数封顶（log-retention.ts 里是 5000 行，内存里只留约 400 条），这些重复把真正冒过的念头
 * 挤了出去：盘上只剩三天半，监控页上只剩最近七个小时，而且几乎全是「未行动」。
 *
 * 所以被门挡住的轮次只在原因变了的时候记一条：进入不应期记一次，入夜记一次，连败退避记一次，
 * 之后原样重复的都不再落盘。比较对象是上一条记下的挡门原因，不是上一个 tick——每冒一个念头
 * 后面都会跟一段不应期，按上一个 tick 比的话，每个念头之后都会再记一条同样的「刚问过」。
 *
 * 冒了念头、主动开口、问了却失败，都是真实发生的事，照记不误；它们也不会重置这里的状态。
 * 进程重启后第一次被挡会重新记一条，正好说明重启后她处在什么状态。
 *
 * 唯一的例外是「循环关着」。不应期、夜里、退避都是日常节奏，反复进出是常态；关循环是有人改了
 * 配置。关了、又开、跑过一轮、再关上——要是第二次关被当成重复吞掉，最后一条自主记录就停在
 * 「冒了个念头」，看着像循环还开着。所以只要关着之后真跑过一轮，下次再关就重新记。
 */
export function createAutonomyTickThoughtGate(): (thought: AutonomyTickThought) => boolean {
  let lastHoldKey: string | null = null;
  let lastHoldWasDisabled = false;
  return (thought) => {
    if (thought.holdKey === null) {
      if (lastHoldWasDisabled) {
        lastHoldKey = null;
        lastHoldWasDisabled = false;
      }
      return true;
    }
    if (thought.holdKey === lastHoldKey) return false;
    lastHoldKey = thought.holdKey;
    lastHoldWasDisabled = thought.outcome === "disabled";
    return true;
  };
}
