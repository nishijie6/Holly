// Which groups earn a context warm.
//
// A warm re-sends a group's history with max_tokens=0 purely to write its prefix
// into Anthropic's prompt cache. At the 1h TTL that write costs 2x base input
// while the read it enables costs 0.1x, so a warm only pays for itself if a
// decision actually reads the entry before it expires. Warming every group that
// merely *received* messages measured out as a net loss — more warms than
// decisions, so most of those writes expired unread.
//
// The gate below is the one rule that separates the two: a group is warm-worthy
// while its reply route has been read inside the TTL window, and goes cold after.

export function shouldWarmReplyRoute(
  lastReadAt: number | undefined,
  now: number,
  windowMs: number,
): boolean {
  // Never read: nothing this process has seen suggests a warm would be consumed.
  if (lastReadAt === undefined) return false;
  return now - lastReadAt <= windowMs;
}

// 预热的总开关。
//
// 这个开关是按「cache write 收 2x 溢价」的账加的：那时预热每 20 分钟追一条已经变长
// 的时间线，五天写进 $10.41、只读回 $0.54，纯亏。但溢价是那笔账唯一的支柱——按当前
// 计费口径 write 不收溢价，预热那笔写就是免费的，而它换来的 read 命中把后续回复的
// uncached 削成零。前提反了，结论跟着反：默认改成开。
//
// 值得记住这两种世界的分界线在哪，免得下次再翻烧饼：凡是「要不要多写一次缓存」的判断
// 都由 write 溢价决定，会随计费口径翻转；凡是「前缀稳不稳」的判断都不受影响——命中的
// 收益只会从省 90% 变成省 100%，稳定前缀在哪种世界里都更值钱，不会更不值钱。
//
// 留着开关本身仍然有意义：write 溢价要是回来了，改一行就能关掉，不用重新翻这段账。
export type ContextWarmConfig = {
  enabled: boolean;
};

export const DEFAULT_CONTEXT_WARM_CONFIG: ContextWarmConfig = {
  enabled: true,
};

export function parseContextWarmConfig(value: unknown): ContextWarmConfig {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
  return {
    enabled: typeof record?.enabled === "boolean" ? record.enabled : DEFAULT_CONTEXT_WARM_CONFIG.enabled,
  };
}
