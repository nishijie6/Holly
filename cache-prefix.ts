import { createHash } from "node:crypto";

// Holly 每次调用都会重建整个请求，而不是持续扩展只追加的消息列表，因此结构上无法
// 阻止易变值漂入缓存前缀。这里能强制保证的是每次调用都经过检查：LLM 客户端为即将
// 发送的前缀生成摘要，并报告它与同一缓存路由上次请求的关系。这样，回归会在下一次
// 回复时直接出现在监控记录里，而不是变成第二天 token 表中无人留意的数字。

// 一条路由代表一条提示缓存谱系。只有预期命中同一缓存条目的请求才共享路由：模型相同、
// 稳定前缀相同，并且只在末尾增长。每个群的时间线属于不同谱系；若共用一条路由，
// 每次切换群都会被误报为漂移。
export type CachePrefixDigest = {
  systemDigest: string;
  // 按线上传输顺序，为每个缓存内容块保存一份摘要。
  blockDigests: string[];
};

export type CachePrefixStatus =
  // 启动后该路由的第一次请求，没有历史可供比较。
  | "fresh"
  // 前缀逐字节相同，可正常读取缓存。
  | "unchanged"
  // 上一个前缀是当前前缀的真前缀，只发生末尾追加，缓存仍然有效。
  | "extended"
  // 断点前有内容变化，或前缀缩短；原条目已经失效，整个前缀需要重新计费。
  | "rebuilt";

export type CachePrefixInspection = {
  route: string;
  status: CachePrefixStatus;
  previousBlocks: number;
  currentBlocks: number;
  systemChanged: boolean;
  // 第一个字节不同的内容块索引；差异位于系统前缀或没有差异时为 -1。
  divergedAt: number;
};

export function digestText(text: string): string {
  return createHash("sha1").update(text, "utf-8").digest("hex").slice(0, 16);
}

export function buildCachePrefixDigest(
  systemTexts: readonly string[],
  blockTexts: readonly string[],
): CachePrefixDigest {
  return {
    // 系统块从开头到断点会作为整体缓存，因此只生成一份摘要。无需判断具体哪个系统块
    // 发生变化，因为任意位置的改变都会使整体失效，结论相同。
    systemDigest: digestText(systemTexts.join("\0")),
    blockDigests: blockTexts.map(digestText),
  };
}

// 设置容量上限，避免长期运行且群很多的进程无限增长；最旧路由被淘汰，下次出现时
// 直接报告为 "fresh"。
const DEFAULT_MAX_ROUTES = 64;

// 用来回答同一问题的另一半。CachePrefixTracker 观察实际发送内容，这里则记录调用方
// 有意改变了什么。缓存滚动窗口的路由会在窗口移动时主动重建前缀，只有非预期重建才
// 值得报警；没有这份意图记录，监控端无法区分两者。
export class StablePrefixLedger {
  private readonly maxRoutes: number;
  private readonly digests = new Map<string, string[]>();

  constructor(maxRoutes: number = DEFAULT_MAX_ROUTES) {
    this.maxRoutes = Math.max(1, maxRoutes);
  }

  // 当前路由的稳定部分与上次发送内容不同时返回 true。首次调用返回 false：没有历史的
  // 路由会被检查为 "fresh" 而非 "rebuilt"，因此也没有需要豁免的重建。
  //
  // 稳定段按块传进来，判断口径和 CachePrefixTracker 一致：只在末尾多了几块叫「延长」，缓存照样
  // 读得回来，不算变化；前面某一块变了、或者块变少了，才是真的重建。以前按整段字符串比，窗口里
  // 每多一条世界观察都被当成重建，把本该命中的请求也记成了「预期内的重建」。
  changed(route: string, stableBlocks: readonly string[]): boolean {
    const digests = stableBlocks.map(digestText);
    const previous = this.digests.get(route);
    if (this.digests.has(route)) {
      this.digests.delete(route);
    }
    this.digests.set(route, digests);
    while (this.digests.size > this.maxRoutes) {
      const oldest = this.digests.keys().next();
      if (oldest.done) break;
      this.digests.delete(oldest.value);
    }
    if (previous === undefined) return false;
    if (digests.length < previous.length) return true;
    return previous.some((digest, index) => digest !== digests[index]);
  }
}

export class CachePrefixTracker {
  private readonly maxRoutes: number;
  private readonly digests = new Map<string, CachePrefixDigest>();

  constructor(maxRoutes: number = DEFAULT_MAX_ROUTES) {
    this.maxRoutes = Math.max(1, maxRoutes);
  }

  inspect(route: string, digest: CachePrefixDigest): CachePrefixInspection {
    const previous = this.digests.get(route) ?? null;
    this.remember(route, digest);

    if (!previous) {
      return {
        route,
        status: "fresh",
        previousBlocks: 0,
        currentBlocks: digest.blockDigests.length,
        systemChanged: false,
        divergedAt: -1,
      };
    }

    const base = {
      route,
      previousBlocks: previous.blockDigests.length,
      currentBlocks: digest.blockDigests.length,
    };

    if (previous.systemDigest !== digest.systemDigest) {
      return { ...base, status: "rebuilt", systemChanged: true, divergedAt: -1 };
    }

    const shared = Math.min(previous.blockDigests.length, digest.blockDigests.length);
    for (let index = 0; index < shared; index += 1) {
      if (previous.blockDigests[index] !== digest.blockDigests[index]) {
        return { ...base, status: "rebuilt", systemChanged: false, divergedAt: index };
      }
    }

    // 即使逐块匹配，前缀缩短也属于重建：原缓存条目越过了新的断点，不会再被读回。
    if (digest.blockDigests.length < previous.blockDigests.length) {
      return {
        ...base,
        status: "rebuilt",
        systemChanged: false,
        divergedAt: digest.blockDigests.length,
      };
    }

    return {
      ...base,
      status: digest.blockDigests.length === previous.blockDigests.length ? "unchanged" : "extended",
      systemChanged: false,
      divergedAt: -1,
    };
  }

  private remember(route: string, digest: CachePrefixDigest): void {
    // 删除后重新插入，让 Map 的插入顺序同时表示最近使用顺序。
    this.digests.delete(route);
    this.digests.set(route, digest);
    while (this.digests.size > this.maxRoutes) {
      const oldest = this.digests.keys().next();
      if (oldest.done) break;
      this.digests.delete(oldest.value);
    }
  }
}

export function describeCachePrefixDrift(inspection: CachePrefixInspection): string {
  if (inspection.systemChanged) {
    return "system prefix changed (persona/protocol edit invalidates every route)";
  }
  if (inspection.currentBlocks < inspection.previousBlocks
    && inspection.divergedAt === inspection.currentBlocks) {
    return `prefix shrank from ${inspection.previousBlocks} to ${inspection.currentBlocks} blocks`;
  }
  return `block #${inspection.divergedAt} of ${inspection.previousBlocks} changed`;
}
