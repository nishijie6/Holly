// L1: the one place every timer / WS trigger turns "something happened" into
// a typed event, instead of each timer deciding what to do and calling the
// model itself (main.ts's dispatchAgentEvent is L2: the single place a
// dispatched event turns into an actual, route-serialized model call via
// RouteQueue).
//
// Events are bare signals, never payloads — the same lesson kagami's
// AGENTS.md documents for its "Foreground Input" path: separate the knock
// from the content, pull content fresh at dispatch time. This fits Holly's
// existing shape for free, since unreadModelMessagesByGroup/dirtyGroupKeys
// are already the source of truth for content; the event only says "go
// look," so a message that arrives between push and dispatch is never lost
// or duplicated — the buffer it lands in is read at dispatch time either way.
export type AgentEvent =
  | { type: "message_batch_ready"; groupKey: string }
  | { type: "context_warm_due"; groupKey: string }
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

  // Dispatches synchronously, in push order — Holly's scale doesn't need a
  // real async drain loop, and every source already coalesces before pushing
  // (a group has at most one pending batch/warm state). A handler that
  // throws is isolated so it never stops the next handler, or the next
  // pushed event, from running; a handler kicking off async work (RouteQueue)
  // is expected to handle its own rejection instead of letting it surface
  // here, exactly like today's per-call .catch() blocks in main.ts.
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

  // Most recent first isn't the point here — callers (the monitor panel)
  // want "what happened, in order," so oldest-of-the-window first, newest
  // last, matching how conversation turns and monitor entries already read.
  recent(limit = DEFAULT_RECENT_LIMIT): readonly AgentEventLogEntry[] {
    if (limit <= 0) return [];
    return this.history.slice(Math.max(0, this.history.length - limit));
  }
}
