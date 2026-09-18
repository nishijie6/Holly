// L1：所有定时器和 WebSocket 触发都只在这里把「有事发生」转换成类型化事件，
// 而不是各自判断该做什么并直接调用模型。main.ts 中的 runAgentEventLoop 是 L2：
// 它是进程里唯一消费这些事件的地方，也是唯一决定「这一刻做什么」的地方。
//
// 事件只传信号，不携带业务数据。这与 kagami 的 AGENTS.md 为「Foreground Input」
// 路径记录的原则相同：把通知与内容分开，在分发时重新读取最新内容。Holly 已将
// unreadModelMessagesByGroup 作为内容的唯一事实来源，事件只表示「去看看」；因此，
// 在入队和消费之间到达的消息既不会丢失也不会重复，消费时总会读取它所在的缓冲区。
// 这条性质也正是事件可以被合并的前提：同一个群的两个事件说的是同一句「去看看」。
//
// 这是一条真队列，不是回调总线。push 只入队并唤醒消费者，什么时候处理、按什么顺序
// 处理，全部由那个消费循环说了算。改成这样是因为同步分发把「何时触发」和「何时执行」
// 焊死了：定时器一响就地开工，而它响的那一刻可能正落在一轮工具循环的中间。要让
// 「只有一条时间线」成为结构保证而不是队列约定，消费必须先从生产里分出来。
export type AgentEvent =
  | { type: "message_batch_ready"; groupKey: string }
  | { type: "autonomy_tick_due" };

export type AgentEventLogEntry = {
  event: AgentEvent;
  at: number;
};

const DEFAULT_RECENT_LIMIT = 50;
const MAX_HISTORY = 200;

export class AgentEventQueue {
  private readonly now: () => number;
  private readonly items: AgentEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly history: AgentEventLogEntry[] = [];

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  // 同步、绝不抛错、绝不阻塞。调用方是 WebSocket 回调和定时器，它们没有能力处理
  // 一个拒绝的 Promise，也不该为了记一笔「有事发生」而等任何东西。
  push(event: AgentEvent): void {
    this.history.push({ event, at: this.now() });
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
    this.items.push(event);
    // 全部唤醒而不是只唤醒一个：等待者各自醒来后会重新取，取空的那个再等下一轮。
    // 目前只有一个消费者，这么写是为了将来多一个也不会静默丢唤醒。
    const toWake = this.waiters.splice(0);
    for (const wake of toWake) {
      wake();
    }
  }

  get pending(): number {
    return this.items.length;
  }

  // 队列非空时立刻返回；否则挂起到下一次 push。不消费任何东西——取由 takeAll 做，
  // 这样「等」和「取」可以分开，消费循环得以在同一个唤醒里把攒下的事件一次收干净。
  async waitNonEmpty(): Promise<void> {
    if (this.items.length > 0) return;
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  // 一次取走全部待处理事件，队列随即清空。返回顺序即入队顺序。
  //
  // 刻意不提供「取一个」：一个一个取会让消费者把攒在一起的事件铺成同样多轮，而它们
  // 本可以在同一轮里一起被看见。谁该合并、怎么合并是消费者的判断，但前提是它得先
  // 看得到全部。
  takeAll(): AgentEvent[] {
    return this.items.splice(0);
  }

  // 返回当前窗口内按时间正序排列的事件，供监控面板依次展示发生过的事情；这与
  // 对话轮次和监控记录的既有读取顺序一致。记的是「推进来过什么」，与是否已被消费无关。
  recent(limit = DEFAULT_RECENT_LIMIT): readonly AgentEventLogEntry[] {
    if (limit <= 0) return [];
    return this.history.slice(Math.max(0, this.history.length - limit));
  }
}

/** 一次取空之后，这一轮到底要做哪些事。 */
export type CoalescedAgentEvents = {
  /** 需要去看的会话，按首次出现的顺序。 */
  groupKeys: string[];
  /** 这一批里有没有自主轮次到期。多个只算一次。 */
  tickDue: boolean;
};

/**
 * 把一次取到的事件折叠成「这一轮要做什么」。
 *
 * 同一个群的多个事件说的是同一句「去看看」——内容不在事件里，取的时候才从缓冲区读（见文件
 * 开头），所以合并掉不会丢任何一条消息，反而让那个群的消息以一个更完整的批次被看见。
 *
 * 自主 tick 同理：消费者忙了五分钟之后攒下五个 tick，连着跑五次判断没有意义——第一次之后
 * 全都会撞在不应期上，白跑五轮闸门判断。
 *
 * 顺序保留首次出现的次序，不去重排。谁先说话谁先被注入，这是她读到的「此刻」的一部分。
 */
export function coalesceAgentEvents(events: readonly AgentEvent[]): CoalescedAgentEvents {
  const groupKeys: string[] = [];
  const seen = new Set<string>();
  let tickDue = false;
  for (const event of events) {
    if (event.type === "autonomy_tick_due") {
      tickDue = true;
      continue;
    }
    if (seen.has(event.groupKey)) continue;
    seen.add(event.groupKey);
    groupKeys.push(event.groupKey);
  }
  return { groupKeys, tickDue };
}
