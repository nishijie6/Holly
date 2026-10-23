export const GITHUB_TRENDING_TOPIC = "GitHub 热门项目";
export const GITHUB_TRENDING_URL = "https://github.com/trending?since=daily";
export const GITHUB_TRENDING_BRIEF =
  "查看 GitHub Trending 日榜的热门开源项目，关注项目用途、主要语言、总 Star、今日新增 Star 和仓库链接。今日上榜或 Star 增长不代表项目今天发布；不要混入旧榜单和无法核实的增长数字。";

// 也用于浏览器里的页面识别，保持独立，不引用模块内的其他变量。
export function isGitHubTrendingUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const ranges = url.searchParams.getAll("since");
    return url.origin === "https://github.com"
      && !url.username && !url.password
      && /^\/trending\/?$/.test(url.pathname)
      && (ranges.length === 0 || (ranges.length === 1 && ranges[0] === "daily"));
  } catch {
    return false;
  }
}

export function isGitHubTrendingSourceList(urls: readonly string[]): boolean {
  return urls.length > 0 && urls.every(isGitHubTrendingUrl);
}

// DOM 只负责读卡片，格式化和链接校验放在进程里。空榜、登录墙、页面结构变化都返回空正文，
// 不能把 GitHub 的语言筛选菜单当成一次成功观察，也不能用抓取时间冒充项目发布时间。
export function formatGitHubTrendingRepositories(value: unknown, pageUrl: string): {
  text: string;
  links: Array<{ text: string; url: string }>;
} {
  const links: Array<{ text: string; url: string }> = [];
  const entries: string[] = [];
  const seen = new Set<string>();
  if (!isGitHubTrendingUrl(pageUrl) || !Array.isArray(value)) return { text: "", links };

  for (const item of value) {
    if (entries.length >= 10) break;
    if (!item || typeof item !== "object") continue;
    const card = item as Record<string, unknown>;
    const read = (key: string) => typeof card[key] === "string" ? card[key].replace(/\s+/g, " ").trim() : "";
    let url: URL;
    try { url = new URL(read("url")); } catch { continue; }
    if (url.origin !== "https://github.com" || url.username || url.password
      || !/^\/[\w-]+\/[\w.-]+\/?$/.test(url.pathname)) continue;
    const name = url.pathname.replace(/^\/|\/$/g, "");
    const href = `https://github.com/${name}`;
    if (seen.has(href.toLowerCase())) continue;
    seen.add(href.toLowerCase());
    const lines = [`${entries.length + 1}. ${name}`, `Repository: ${href}`];
    if (read("description")) lines.push(`Description: ${read("description").slice(0, 400)}`);
    if (read("language")) lines.push(`Language: ${read("language")}`);
    if (read("stars")) lines.push(`Stars: ${read("stars")}`);
    if (read("starsToday")) lines.push(`Stars today: ${read("starsToday").replace(/\s+stars?\s+today$/i, "")}`);
    entries.push(lines.join("\n"));
    links.push({ text: name, url: href });
  }

  return {
    text: entries.length > 0
      ? ["GitHub Trending 日榜：这是本次抓取的今日热度，不代表项目今天发布。", ...entries].join("\n\n")
      : "",
    links,
  };
}
