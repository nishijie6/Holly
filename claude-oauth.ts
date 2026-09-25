import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Holly 自己的一份 Claude 登录会话。以前 Holly 直接借用 Claude Code 存在钥匙串和
// ~/.claude/.credentials.json 里的票据，可 refresh token 是轮换的：谁先拿它去刷新，
// 另一方手里那张就作废。Holly 常驻后台、夜里也在刷新，结果就是 Claude Code 隔三岔五
// 被踢下线要求重新登录。自己走一遍 PKCE 登录拿到的是另一条独立的票据链，两边各刷
// 各的，互不影响——所以这里刻意不读钥匙串，也不碰 ~/.claude/ 下的任何文件。

// 授权地址、回调路径和 token 端点都照抄当前官方 CLI 二进制里的写法，不要凭印象改：
// console.anthropic.com 前面那层边缘防护会把请求拦成 403 质询页，「地址不对」会伪装成
// 「账号被拒」。
const CLAUDE_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// 只要推理和读取账号资料两项；CLI 申请的会话、MCP、插件等权限 Holly 用不上。
const CLAUDE_OAUTH_SCOPE = "user:profile user:inference";
// 不带 UA 的请求会被边缘防护当成脚本挡下，拿回一页 HTML 质询而不是 JSON，真实的 4xx
// 原因就丢了。版本号本身不参与鉴权，过期了也无妨，只要别是空 UA。
const CLAUDE_OAUTH_USER_AGENT = "claude-cli/2.1.206 (external, cli)";

export const CLAUDE_OAUTH_LOGIN_PATH = "/oauth/claude/login";
// 回调路径必须是 /callback：这是授权服务器为这个 client 登记的回环地址形态，端口随意。
export const CLAUDE_OAUTH_CALLBACK_PATH = "/callback";

// 可用 HOLLY_CLAUDE_OAUTH_STORE 指到别处；在第一次用到时才解析，好让测试在 import 之后
// 再把它指向临时文件，而不是读到本机真实的登录。
function defaultStorePath(): string {
  return process.env.HOLLY_CLAUDE_OAUTH_STORE || path.join(process.cwd(), ".claude-oauth", "credentials.json");
}

// 从点开登录链接到在浏览器里点完授权，十分钟足够；过期的 state 留着只会让回调被重放。
const PENDING_LOGIN_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;
// 刷新失败后先歇一分钟。以前每次调用都会重试刷新，一次网络抖动就能在两天里打出三千多次
// token 请求，这种频率本身就可能招来风控。
const REFRESH_FAILURE_COOLDOWN_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_MAX_ATTEMPTS = 3;
const TOKEN_REQUEST_RETRY_DELAY_MS = 500;

export type ClaudeCredentials = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string | null;
};

// 没有登录，或者票据链已经被服务端作废；调用方看到它就该提示人去登录，而不是重试。
export class ClaudeLoginRequiredError extends Error {
  constructor(reason: string) {
    super(`Claude 需要登录（${reason}）：在浏览器打开 Holly 监控页的 ${CLAUDE_OAUTH_LOGIN_PATH}`);
    this.name = "ClaudeLoginRequiredError";
  }
}

type PendingLogin = { codeVerifier: string; redirectUri: string; createdAt: number };

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  account?: { email_address?: unknown };
};

export function buildClaudeAuthorizeUrl(input: { redirectUri: string; state: string; codeChallenge: string }): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: CLAUDE_OAUTH_SCOPE,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    state: input.state,
  });
  return `${CLAUDE_AUTHORIZE_URL}?${params.toString()}`;
}

export function parseStoredClaudeCredentials(rawJson: string): ClaudeCredentials {
  const raw = JSON.parse(rawJson) as Record<string, unknown>;
  const { accessToken, refreshToken, expiresAt, email } = raw;
  if (typeof accessToken !== "string" || !accessToken) throw new Error("accessToken missing");
  if (typeof refreshToken !== "string" || !refreshToken) throw new Error("refreshToken missing");
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) throw new Error("expiresAt missing");
  return { accessToken, refreshToken, expiresAt, email: typeof email === "string" ? email : null };
}

function isExpiringSoon(expiresAt: number): boolean {
  return Date.now() + TOKEN_REFRESH_BUFFER_MS >= expiresAt;
}

export class ClaudeOAuthSession {
  private readonly credentialsPathOverride: string | undefined;
  private readonly fetchImpl: typeof fetch;
  // undefined 表示还没读过磁盘，null 表示读过但没有票据。
  private creds: ClaudeCredentials | null | undefined = undefined;
  // 同一时刻只允许一次刷新在飞。refresh token 是一次性的，两个并发调用各自拿同一张去刷，
  // 后到的那个会拿着已作废的票据失败，甚至让整条票据链被服务端判定为重放而吊销。
  private refreshing: Promise<ClaudeCredentials> | null = null;
  private lastRefreshFailureAt = 0;
  // 服务端已明确作废这条票据链时记下原因，之后直接报「需要登录」，不再每分钟去撞一次
  // token 端点，直到重新登录。
  private loginRequired: ClaudeLoginRequiredError | null = null;
  private readonly pendingLogins = new Map<string, PendingLogin>();

  constructor(options: { storePath?: string; fetchImpl?: typeof fetch } = {}) {
    this.credentialsPathOverride = options.storePath;
    // 不在构造时捕获全局 fetch，调用时再取，这样替换 globalThis.fetch 的测试桩对 token 请求同样生效。
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get credentialsPath(): string {
    return this.credentialsPathOverride ?? defaultStorePath();
  }

  async hasCredentials(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  // 生成一次性的 PKCE 参数并返回授权地址。verifier 只留在内存里，Holly 重启后没走完的
  // 登录作废，重新点一次链接就好，不值得为此落盘。
  beginLogin(redirectUri: string): string {
    this.prunePendingLogins();
    const state = randomBytes(24).toString("hex");
    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    this.pendingLogins.set(state, { codeVerifier, redirectUri, createdAt: Date.now() });
    return buildClaudeAuthorizeUrl({ redirectUri, state, codeChallenge });
  }

  async completeLogin(code: string, state: string): Promise<ClaudeCredentials> {
    this.prunePendingLogins();
    const pending = this.pendingLogins.get(state);
    // state 对不上就拒绝：否则任何能让浏览器访问本机回调的页面，都能把它自己的授权码
    // 塞给 Holly，让 Holly 登进别人的账号。
    if (!pending) throw new Error("登录请求不存在或已过期，请重新打开登录链接");
    this.pendingLogins.delete(state);

    const creds = await this.requestTokens(
      {
        grant_type: "authorization_code",
        code,
        state,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
      },
      null,
    );
    await this.save(creds);
    this.lastRefreshFailureAt = 0;
    this.loginRequired = null;
    return creds;
  }

  async getCredentials(): Promise<ClaudeCredentials> {
    if (this.loginRequired) throw this.loginRequired;
    const creds = await this.load();
    if (!creds) throw new ClaudeLoginRequiredError(`未找到 ${this.credentialsPath}`);
    if (!isExpiringSoon(creds.expiresAt)) return creds;

    try {
      return await this.refresh(creds);
    } catch (error) {
      if (error instanceof ClaudeLoginRequiredError) throw error;
      // 网络抖动或边缘防护拦截时，手里的 access token 往往还有几分钟可用，先凑合着发；
      // 真过期了，请求会以 401 失败，再由调用方走 forceRefresh。
      console.warn("Claude token refresh failed; continuing with the current token.", error);
      return creds;
    }
  }

  // 请求返回 401/403 时调用：`stale` 是刚被拒的那份票据。若别的调用已经换过新票据，就
  // 直接用新的，不再花一次刷新。
  async forceRefresh(stale: ClaudeCredentials): Promise<ClaudeCredentials | null> {
    try {
      return await this.refresh(stale);
    } catch (error) {
      console.warn("Claude token refresh after auth failure failed.", error);
      return null;
    }
  }

  private refresh(from: ClaudeCredentials): Promise<ClaudeCredentials> {
    if (this.refreshing) return this.refreshing;
    if (this.creds && this.creds.accessToken !== from.accessToken) return Promise.resolve(this.creds);
    if (Date.now() - this.lastRefreshFailureAt < REFRESH_FAILURE_COOLDOWN_MS) {
      return Promise.reject(new Error("Claude token refresh is cooling down after a recent failure"));
    }

    this.refreshing = (async () => {
      try {
        const next = await this.requestTokens(
          { grant_type: "refresh_token", refresh_token: from.refreshToken, client_id: CLAUDE_OAUTH_CLIENT_ID },
          from,
        );
        await this.save(next);
        return next;
      } catch (error) {
        this.lastRefreshFailureAt = Date.now();
        if (error instanceof ClaudeLoginRequiredError) this.loginRequired = error;
        throw error;
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async requestTokens(
    payload: Record<string, string>,
    previous: ClaudeCredentials | null,
  ): Promise<ClaudeCredentials> {
    const res = await this.postTokenRequest(payload);

    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 500);
      // 400/401 是服务端明确不认这张票据（invalid_grant 之类），再刷也没用，只能重新登录。
      // 403 不算：边缘防护的质询页也是 403，那是网络出口的问题，换个节点就好。
      if (previous && (res.status === 400 || res.status === 401)) {
        throw new ClaudeLoginRequiredError(`刷新被拒 ${res.status}: ${body || "<empty>"}`);
      }
      throw new Error(`Claude token request failed (${res.status}): ${body || "<empty>"}`);
    }

    const data = (await res.json()) as TokenResponse;
    if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
      throw new Error("Claude token response is missing access_token or expires_in");
    }
    const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : previous?.refreshToken;
    if (!refreshToken) throw new Error("Claude token response is missing refresh_token");
    const email = typeof data.account?.email_address === "string" ? data.account.email_address : null;

    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      email: email ?? previous?.email ?? null,
    };
  }

  // 这台机器的代理出口时不时在 TLS 握手阶段掐断连接。登录回调的 state 只能用一次，一次抖动
  // 就得从头再点一遍授权，所以网络层失败要就地重试。只重试抛出的异常，不重试 HTTP 错误：
  // 连接没建立时请求根本没到服务端，授权码和 refresh token 都还没被用掉，原样重发是安全的；
  // 超时那种可能已被服务端处理的，重发最坏也就是被拒，结局和不重试一样。
  private async postTokenRequest(payload: Record<string, string>): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": CLAUDE_OAUTH_USER_AGENT },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt >= TOKEN_REQUEST_MAX_ATTEMPTS) throw error;
        console.warn(`Claude token request failed (${attempt}/${TOKEN_REQUEST_MAX_ATTEMPTS}), retrying.`, error);
        await new Promise((resolve) => setTimeout(resolve, attempt * TOKEN_REQUEST_RETRY_DELAY_MS));
      }
    }
  }

  private async load(): Promise<ClaudeCredentials | null> {
    if (this.creds !== undefined) return this.creds;
    let loaded: ClaudeCredentials | null;
    try {
      loaded = parseStoredClaudeCredentials(await readFile(this.credentialsPath, "utf-8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Ignoring unreadable Claude credentials at ${this.credentialsPath}.`, error);
      }
      loaded = null;
    }
    // 启动时几个调用可能同时来读盘；慢的那次若在刷新落盘之后才返回，不能拿它读到的旧票据
    // 盖掉内存里的新票据——旧的 refresh token 已经用掉了。
    if (this.creds === undefined) this.creds = loaded;
    return this.creds;
  }

  // 先写临时文件再改名：写到一半进程被杀，留下的也是完整的旧票据，而不是半截 JSON——
  // 那样刚轮换掉的旧票据已作废、新票据又读不出来，就只能重新登录了。
  private async save(creds: ClaudeCredentials): Promise<void> {
    await mkdir(path.dirname(this.credentialsPath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.credentialsPath}.${process.pid}.tmp`;
    await writeFile(tmpPath, JSON.stringify(creds, null, 2), { encoding: "utf-8", mode: 0o600 });
    await rename(tmpPath, this.credentialsPath);
    this.creds = creds;
  }

  private prunePendingLogins(): void {
    const cutoff = Date.now() - PENDING_LOGIN_TTL_MS;
    for (const [state, pending] of this.pendingLogins) {
      if (pending.createdAt < cutoff) this.pendingLogins.delete(state);
    }
  }
}

export const claudeOAuth = new ClaudeOAuthSession();
