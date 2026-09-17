// L1：所有定时器和 WebSocket 触发都只在这里把「有事发生」转换成类型化事件，
// 而不是各自判断该做什么并直接调用模型。main.ts 中的 dispatchAgentEvent 是 L2：
// 它负责把已分发的事件转换成由 RouteQueue 按路由串行执行的真实模型调用。
//
// 事件只传信号，不携带业务数据。这与 kagami 的 AGENTS.md 为「Foreground Input」
// 路径记录的原则相同：把通知与内容分开，在分发时重新读取最新内容。Holly 已将
// unreadModelMessagesByGroup 作为内容的唯一事实来源，事件只表示「去看看」；因此，
// 在入队和分发之间到达的消息既不会丢失也不会重复，分发时总会读取它所在的缓冲区。
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
  private readonly handlers: Array<(event: AgentEvent) => void> = [];
  private readonly history: AgentEventLogEntry[] = [];

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  onEvent(handler: (event: AgentEvent) => void): void {
    this.handlers.push(handler);
  }

  // 按入队顺序同步分发。Holly 当前的规模不需要真正的异步排空循环，而且各事件源
  // 会在入队前先合并，同一个群最多只有一个待处理批次。单个处理器抛错会被隔离，
  // 不会阻止后续处理器或后续事件运行；通过 RouteQueue 启动异步工作的处理器应自行
  // 处理拒绝，方式与 main.ts 中各调用点的 .catch() 一致。
  push(event: AgentEvent): void {
    this.history.push({ event, at: this.now() });
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error("agent-events: handler threw for", event.type, error);
      }
    }
  }

  // 返回当前窗口内按时间正序排列的事件，供监控面板依次展示发生过的事情；这与
  // 对话轮次和监控记录的既有读取顺序一致。
  recent(limit = DEFAULT_RECENT_LIMIT): readonly AgentEventLogEntry[] {
    if (limit <= 0) return [];
    return this.history.slice(Math.max(0, this.history.length - limit));
  }
}
