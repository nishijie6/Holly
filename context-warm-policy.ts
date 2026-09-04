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
