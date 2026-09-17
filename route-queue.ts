// 用结构化、可测试且可复用的并发原语，替代 main.ts 中手写的全局 Promise 链
// （原模块级 `modelQueue` / `autonomyQueue`）。每次回复调用都提交到其读写缓存前缀
// 所属群的同一路由（见 main.ts 的 replyCacheRoute）：同一路由严格先进先出，因此会
// 争用同一前缀的两个请求绝不会并发；不同路由则完全并行，一个群的慢请求不再阻塞
// 其他群。相比原来的单条全局链，这不仅是重构，也改善了实际并发行为。
export class RouteQueue {
  private readonly tails = new Map<string, Promise<void>>();
  // 独占任务运行期间保持未完成，使此时到达的 submit() 等待独占任务，而不会抢先执行。
  private exclusiveGate: Promise<void> = Promise.resolve();

  // 上一个任务失败不能永久卡死该路由，后续 submit() 仍应正常执行。错误不会对调用方
  // 静默吞掉：submit 返回的 `run` 依然会拒绝，只有内部保存的队尾会被收敛为完成状态。
  async submit<T>(route: string, task: () => Promise<T>): Promise<T> {
    await this.exclusiveGate;
    const previousTail = this.tails.get(route) ?? Promise.resolve();
    const settledPrevious = previousTail.catch(() => {
      // 故意留空，原因见上方注释。
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

  // 供启动后才能确定会访问哪些路由的调用方使用，例如遍历所有群决定是否发言的主动轮次。
  // 先等待当前已排队任务全部结束，再在本队列没有其他在途任务时执行 task()，最后放行。
  //
  // 等待集合是调用时取得的快照，不会持续追踪新任务：只等待当时已进入各路由的工作。
  // 闸门重开后，submit 内重新读取的路由队尾一定包含本次独占调用的完成状态，因此 task()
  // 执行期间异步安排的任务既不会漏掉，也不会被重复计入。
  async submitExclusive<T>(task: () => Promise<T>): Promise<T> {
    const pendingRouteWork = Promise.allSettled([...this.tails.values()]);
    const previousGate = this.exclusiveGate;
    let release: () => void = () => {};
    this.exclusiveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      // 第二个独占调用必须排在第一个之后；「独占」也包括不能与其他独占任务并行。
      await previousGate;
      await pendingRouteWork;
      return await task();
    } finally {
      release();
    }
  }
}
