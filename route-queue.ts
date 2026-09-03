// Concurrency primitive that replaces main.ts's hand-rolled global promise
// chains (the old `modelQueue` / `autonomyQueue` module-level `let`s) with
// something shaped, testable, and reusable. Every reply/warm call submits on
// the same route as the group whose cache prefix it reads or writes (see
// replyCacheRoute in main.ts): same route -> strict FIFO, so two requests
// that would fight over the same prefix never run concurrently. Different
// routes run fully in parallel, so one group's slow call no longer blocks
// another's — a real behaviour improvement over the old single global chain,
// not just a refactor.
export class RouteQueue {
  private readonly tails = new Map<string, Promise<void>>();
  // Held pending while an exclusive task runs, so a submit() that arrives
  // during that window waits for it instead of slipping in ahead of it.
  private exclusiveGate: Promise<void> = Promise.resolve();

  // A prior failure on a route must not wedge that route forever — the next
  // submit() on it should still run. Never swallowed for the caller: `run`
  // (what submit returns) still rejects; only the stored tail is settled.
  async submit<T>(route: string, task: () => Promise<T>): Promise<T> {
    await this.exclusiveGate;
    const previousTail = this.tails.get(route) ?? Promise.resolve();
    const settledPrevious = previousTail.catch(() => {
      // Intentionally empty: see comment above.
    });
    const run = settledPrevious.then(task);
    this.tails.set(
      route,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  // For the one caller that doesn't know which routes it will touch until
  // it's already running (a proactive tick loops over every group deciding
  // whether to speak): wait for everything already queued to drain, run
  // task() with nothing else from this queue in flight, then release.
  //
  // The wait is a snapshot taken at call time, not a live view: work already
  // queued on any route is awaited, but only that work — a route's tail
  // read afterwards (inside submit, once the gate reopens) always reflects
  // this exclusive call's own completion, so nothing async-scheduled during
  // task() can be missed or double-counted.
  async submitExclusive<T>(task: () => Promise<T>): Promise<T> {
    const pendingRouteWork = Promise.allSettled([...this.tails.values()]);
    const previousGate = this.exclusiveGate;
    let release: () => void = () => {};
    this.exclusiveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      // A second exclusive call queues behind the first rather than running
      // alongside it — "exclusive" means exclusive of other exclusive work too.
      await previousGate;
      await pendingRouteWork;
      return await task();
    } finally {
      release();
    }
  }
}
