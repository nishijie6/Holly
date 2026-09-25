import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClaudeLoginRequiredError, ClaudeOAuthSession, type ClaudeCredentials } from "../claude-oauth.js";

// Holly 的 Claude 票据链与 Claude Code 隔离后，唯一能把它弄坏的就是 Holly 自己：并发刷新
// 让一次性的 refresh token 被用两次，或者票据已被作废还不停地撞 token 端点。这里钉住这几条。

const REDIRECT_URI = "http://localhost:5000/callback";

type Call = { url: string; body: Record<string, string> };

function fakeFetch(respond: (body: Record<string, string>) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    calls.push({ url: String(url), body });
    return respond(body);
  }) as typeof fetch;
  return { impl, calls };
}

function tokenResponse(accessToken: string, refreshToken = `${accessToken}-refresh`): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 28_800,
      account: { email_address: "holly@example.com" },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "holly-claude-oauth-"));
  return path.join(dir, "nested", "credentials.json");
}

async function seedStore(storePath: string, creds: ClaudeCredentials): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(creds));
}

const expiring = (): ClaudeCredentials => ({
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: Date.now() + 60_000,
  email: "holly@example.com",
});

test("a login round-trips PKCE and persists credentials only to Holly's own store", async () => {
  const storePath = await tempStorePath();
  const { impl, calls } = fakeFetch(() => tokenResponse("new-access"));
  const session = new ClaudeOAuthSession({ storePath, fetchImpl: impl });

  const authorizeUrl = new URL(session.beginLogin(REDIRECT_URI));
  assert.equal(authorizeUrl.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizeUrl.searchParams.get("scope"), "user:profile user:inference");
  const state = authorizeUrl.searchParams.get("state");
  const challenge = authorizeUrl.searchParams.get("code_challenge");
  assert.ok(state && challenge);

  const creds = await session.completeLogin("auth-code", state);
  assert.equal(creds.accessToken, "new-access");
  assert.equal(creds.email, "holly@example.com");

  assert.equal(calls.length, 1);
  const exchange = calls[0].body;
  assert.equal(exchange.grant_type, "authorization_code");
  assert.equal(exchange.code, "auth-code");
  assert.equal(exchange.redirect_uri, REDIRECT_URI);
  assert.equal(createHash("sha256").update(exchange.code_verifier).digest("base64url"), challenge);

  const saved = JSON.parse(await readFile(storePath, "utf-8")) as ClaudeCredentials;
  assert.equal(saved.refreshToken, "new-access-refresh");
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
});

test("a TLS reset during the code exchange is retried, so one network blip does not waste the login", async () => {
  const storePath = await tempStorePath();
  let attempts = 0;
  const { impl, calls } = fakeFetch(() => {
    attempts += 1;
    if (attempts === 1) {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("Client network socket disconnected before secure TLS connection was established"), { code: "ECONNRESET" }),
      });
    }
    return tokenResponse("after-retry");
  });
  const session = new ClaudeOAuthSession({ storePath, fetchImpl: impl });
  const state = new URL(session.beginLogin(REDIRECT_URI)).searchParams.get("state")!;

  const creds = await session.completeLogin("auth-code", state);
  assert.equal(creds.accessToken, "after-retry");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.code, "auth-code");
});

test("a callback whose state Holly never issued is rejected without touching the token endpoint", async () => {
  const { impl, calls } = fakeFetch(() => tokenResponse("x"));
  const session = new ClaudeOAuthSession({ storePath: await tempStorePath(), fetchImpl: impl });
  session.beginLogin(REDIRECT_URI);

  await assert.rejects(session.completeLogin("attacker-code", "forged-state"));
  assert.equal(calls.length, 0);
});

test("a state is single-use, so a replayed callback cannot log in twice", async () => {
  const { impl } = fakeFetch(() => tokenResponse("a"));
  const session = new ClaudeOAuthSession({ storePath: await tempStorePath(), fetchImpl: impl });
  const state = new URL(session.beginLogin(REDIRECT_URI)).searchParams.get("state")!;

  await session.completeLogin("code", state);
  await assert.rejects(session.completeLogin("code", state));
});

test("without a login, callers get ClaudeLoginRequiredError rather than a borrowed system token", async () => {
  const session = new ClaudeOAuthSession({ storePath: await tempStorePath(), fetchImpl: fakeFetch(() => tokenResponse("x")).impl });
  await assert.rejects(session.getCredentials(), ClaudeLoginRequiredError);
});

test("concurrent callers share one refresh, so the one-time refresh token is spent once", async () => {
  const storePath = await tempStorePath();
  await seedStore(storePath, expiring());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { impl, calls } = fakeFetch(async () => {
    await gate;
    return tokenResponse("fresh-access");
  });
  const session = new ClaudeOAuthSession({ storePath, fetchImpl: impl });

  const pending = Promise.all([session.getCredentials(), session.getCredentials(), session.getCredentials()]);
  // 让三个调用都走到「需要刷新」再放行响应，否则第一个可能在后两个开始前就已完成。
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await pending;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.refresh_token, "old-refresh");
  assert.deepEqual(results.map((c) => c.accessToken), ["fresh-access", "fresh-access", "fresh-access"]);
  const saved = JSON.parse(await readFile(storePath, "utf-8")) as ClaudeCredentials;
  assert.equal(saved.refreshToken, "fresh-access-refresh");
});

test("after a 401 the retry adopts a refresh another request already made instead of spending another", async () => {
  const storePath = await tempStorePath();
  await seedStore(storePath, { ...expiring(), expiresAt: Date.now() + 3_600_000 });
  const { impl, calls } = fakeFetch(() => tokenResponse("fresh-access"));
  const session = new ClaudeOAuthSession({ storePath, fetchImpl: impl });

  const stale = await session.getCredentials();
  const first = await session.forceRefresh(stale);
  const second = await session.forceRefresh(stale);

  assert.equal(calls.length, 1);
  assert.equal(first?.accessToken, "fresh-access");
  assert.equal(second?.accessToken, "fresh-access");
});

test("a refresh the server rejects as invalid stops further attempts until the next login", async () => {
  const storePath = await tempStorePath();
  await seedStore(storePath, expiring());
  const { impl, calls } = fakeFetch(
    () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
  );
  const session = new ClaudeOAuthSession({ storePath, fetchImpl: impl });

  await assert.rejects(session.getCredentials(), ClaudeLoginRequiredError);
  await assert.rejects(session.getCredentials(), ClaudeLoginRequiredError);
  assert.equal(calls.length, 1);
});

test("an edge-protection 403 keeps the current token in play and cools down instead of hammering", async () => {
  const storePath = await tempStorePath();
  await seedStore(storePath, expiring());
  const { impl, calls } = fakeFetch(
    () => new Response("<!DOCTYPE html><title>Just a moment...</title>", { status: 403 }),
  );
  const session = new ClaudeOAuthSession({ storePath, fetchImpl: impl });

  assert.equal((await session.getCredentials()).accessToken, "old-access");
  assert.equal((await session.getCredentials()).accessToken, "old-access");
  assert.equal(calls.length, 1);
});
