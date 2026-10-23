// 监控页只绑 127.0.0.1，但浏览器里任何网页都能向 127.0.0.1 发请求：跨站 POST（text/plain 就
// 不触发预检）能改 read_only 和广播目标，DNS rebinding 还能把聊天记录读走。所以 Host 必须是
// 本机名字（挡 rebinding），带 Origin 的请求必须来自监控页自己（挡跨站）。curl 之类不带
// Origin 的本地调用照常放行。
export function createLocalRequestGuard(host: string, port: number) {
  const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`]);
  return (requestHost: string | undefined, origin: string | undefined): boolean => {
    if (!requestHost || !allowedHosts.has(requestHost.toLowerCase())) return false;
    if (origin === undefined) return true;
    return [...allowedHosts].some((allowed) => origin.toLowerCase() === `http://${allowed}`);
  };
}
