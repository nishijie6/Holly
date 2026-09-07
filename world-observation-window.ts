// 记忆反思那半段「稳定素材」到底取哪几条世界观察。
//
// 这段素材是 buildMemoryReflectionPrompt 的 stable 半边，缓存断点就落在它后面，所以
// 它字节不变的时候整段前缀才能续上。原来的取法是每次调用现算 `24h 之内 + 最后 6 条`：
// 两个窗口都跟着墙上时钟滑，时间流逝本身就会把最旧的一条挤出去，于是两次反思之间没
// 有任何新观察也能让前缀变样。再加上渲染时用数组下标编号（`World observation 1/2/3`），
// 窗口一移所有条目的编号集体左移，前缀从第一个块就对不上——名义上的 stable 半边，实
// 测五天 0% 命中、47 万 token 按未缓存全价重读。
//
// 这里换成滞后窗口：起点 fromMs 平时钉死不动，只有累积条数超过 highWater 才一次性推
// 到只剩 lowWater 条。于是大多数轮次只在尾部追加（前缀 extend、缓存续得上），每
// highWater-lowWater 轮才付一次重建。跟 ledger-compaction 是同一个思路，区别只是这里
// 的一次重建便宜到不值得再生成摘要——旧观察本来就会被 24h 规则淘汰，直接丢掉即可。
//
// 不在这里做的事：24h 过期与 128 条上限的裁剪归 rememberWorldObservation 管，写入时做
// 一次就够。这里再按当前时间滤一遍正是前面那个 bug 的来源，所以刻意不碰时钟——这个
// 模块拿不到 now，也不需要。

export type ObservationWindowOptions = {
  // 稳态下窗口至少保留多少条：一次重建之后剩下的条数。
  lowWater: number;
  // 涨到多少条触发一次重建。跟 lowWater 的差额就是「两次重建之间能白拿多少轮缓存」，
  // 调大越省钱、但进上下文的观察条数波动越大（反思看到的素材会在 low~high 之间浮动）。
  highWater: number;
};

export const DEFAULT_OBSERVATION_WINDOW_OPTIONS: ObservationWindowOptions = {
  lowWater: 6,
  highWater: 12,
};

export type ObservationWindowResult<T> = {
  // 这一轮该进 prompt 的观察，按原顺序。
  window: T[];
  // 下一轮要带回来的窗口起点。调用方负责存住它——它就是「前缀从哪里开始」这件事本身。
  fromMs: number;
  // 这一轮是否推了窗口。true 意味着前缀重建，调用方该把它当成预期内的 rebuild 报给
  // 缓存监控（expectRebuild），而不是让它冒充一次没人干的漂移。
  compacted: boolean;
};

export function selectObservationWindow<T extends { observedAtMs: number }>(
  observations: readonly T[],
  fromMs: number,
  options: ObservationWindowOptions = DEFAULT_OBSERVATION_WINDOW_OPTIONS,
): ObservationWindowResult<T> {
  const lowWater = Math.max(1, Math.floor(options.lowWater));
  const highWater = Math.max(lowWater, Math.floor(options.highWater));

  // 起点之前的条目已经被上一次重建划出去了，永远不再回来——即使它们还留在
  // observations 里（128 条上限比这个窗口宽得多）。
  const eligible = observations.filter((item) => item.observedAtMs >= fromMs);

  if (eligible.length <= highWater) {
    return { window: [...eligible], fromMs, compacted: false };
  }

  const kept = eligible.slice(-lowWater);
  // 新起点取保留段第一条自己的时间戳，而不是「现在减去多久」：窗口的位置从此只由观察
  // 本身决定，不由调用时刻决定，这正是原来那个 bug 缺的那一半。
  return { window: kept, fromMs: kept[0].observedAtMs, compacted: true };
}
