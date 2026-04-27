import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

export type LlmMessageRole = "system" | "user" | "assistant";

export type LlmMessage = {
  role: LlmMessageRole;
  content: string;
};

type CodexProfileConfig = {
  provider: "codex";
  model?: string;
  system_prompt?: string;
};

export type LlmProfileConfig = CodexProfileConfig;

type LlmSectionConfig = {
  active?: string;
  system_prompt?: string;
  profiles?: Record<string, LlmProfileConfig>;
};

type AppConfig = {
  llm?: LlmSectionConfig;
};

export type ResolvedLlmProfile = {
  name: string;
  provider: "codex";
  model: string;
  systemPrompt: string;
};

export type LlmClient = {
  profileName: string;
  provider: "codex";
  model: string;
  systemPrompt: string;
  displayName: string;
  generateText(input: {
    messages: LlmMessage[];
    systemPrompt?: string;
  }): Promise<string>;
};

export type LlmProfileSummary = {
  name: string;
  provider: "codex";
  model: string;
  displayName: string;
};

type CredentialsSource = "project" | "keychain" | "home";

type CodexCredentials = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  accountId?: string;
  source: CredentialsSource;
  rawTokens: Record<string, unknown>;
};

type CodexInputItem = {
  role: "user" | "assistant";
  content: string;
};

type CodexRequestBody = {
  model: string;
  input: CodexInputItem[];
  instructions?: string;
  store: false;
  stream?: boolean;
  reasoning?: {
    effort: "none" | "low" | "medium" | "high" | "xhigh";
  };
};

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant. Keep answers clear and concise.";
const KEYCHAIN_SERVICE = "Codex Auth";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_AUTH_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const PROJECT_AUTH_PATH = path.join(process.cwd(), ".codex", "auth.json");
const HOME_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const TOKEN_REFRESH_BUFFER_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEBUG_REQUEST = process.env.CODEX_DEBUG_REQUEST === "1";

function isFetchFailedError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("fetch failed");
}

async function loadConfig(configPath: string): Promise<AppConfig> {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}.`);
  }

  const raw = await readFile(configPath, "utf-8");
  return (YAML.parse(raw) as AppConfig | null) ?? {};
}

async function saveConfig(configPath: string, config: AppConfig): Promise<void> {
  const body = YAML.stringify(config);
  await writeFile(configPath, body, "utf-8");
}

function splitSystemPrompt(messages: LlmMessage[], baseSystemPrompt: string): {
  systemPrompt: string;
  contents: LlmMessage[];
} {
  const systemBlocks = [baseSystemPrompt];
  const contents: LlmMessage[] = [];

  for (const message of messages) {
    const content = message.content.trim();
    if (!content) {
      continue;
    }

    if (message.role === "system") {
      systemBlocks.push(content);
      continue;
    }

    contents.push({
      role: message.role,
      content,
    });
  }

  return {
    systemPrompt: systemBlocks.filter(Boolean).join("\n\n"),
    contents,
  };
}

function parseJwtExp(jwt: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf-8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isExpiringSoon(expiresAt: number | null): boolean {
  if (expiresAt === null) return false;
  return Date.now() + TOKEN_REFRESH_BUFFER_MS >= expiresAt;
}

function resolveCodexHome(): string {
  const configured = process.env.CODEX_HOME;
  const home = configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
  try {
    return realpathSync.native(home);
  } catch {
    return home;
  }
}

function computeKeychainAccount(codexHome: string): string {
  const hash = createHash("sha256").update(codexHome).digest("hex");
  return `cli|${hash.slice(0, 16)}`;
}

function parseTokensPayload(raw: string, source: CredentialsSource): CodexCredentials {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const tokens = data.tokens as Record<string, unknown> | undefined;
  if (!tokens) throw new Error("tokens not found in auth.json");

  const accessToken = tokens.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("access_token not found in auth.json");
  }

  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : null;
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id : undefined;

  return {
    accessToken,
    refreshToken,
    expiresAt: parseJwtExp(accessToken),
    accountId,
    source,
    rawTokens: tokens,
  };
}

async function writeProjectAuth(creds: CodexCredentials): Promise<void> {
  const tokens = {
    ...creds.rawTokens,
    access_token: creds.accessToken,
    refresh_token: creds.refreshToken,
  };
  await mkdir(path.dirname(PROJECT_AUTH_PATH), { recursive: true });
  await writeFile(PROJECT_AUTH_PATH, JSON.stringify({ tokens }), { encoding: "utf-8", mode: 0o600 });
}

async function readCodexCredentials(): Promise<CodexCredentials> {
  try {
    return parseTokensPayload(await readFile(PROJECT_AUTH_PATH, "utf-8"), "project");
  } catch {
    // Fall through to system stores.
  }

  if (process.platform === "darwin") {
    try {
      const codexHome = resolveCodexHome();
      const account = computeKeychainAccount(codexHome);
      const raw = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${account}" -w`,
        { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
      );
      return parseTokensPayload(raw.trim(), "keychain");
    } catch {
      // Fall through to home file.
    }
  }

  return parseTokensPayload(await readFile(HOME_AUTH_PATH, "utf-8"), "home");
}

async function refreshCodexCredentials(creds: CodexCredentials): Promise<CodexCredentials | null> {
  if (!creds.refreshToken) {
    return null;
  }

  const res = await fetch(CODEX_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: CODEX_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Codex token refresh failed (${res.status}): ${body || "<empty>"}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };

  const refreshed: CodexCredentials = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? creds.refreshToken,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : parseJwtExp(data.access_token),
    accountId: creds.accountId,
    source: "project",
    rawTokens: {
      ...creds.rawTokens,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? creds.refreshToken,
      ...(data.id_token && { id_token: data.id_token }),
    },
  };

  await writeProjectAuth(refreshed);
  return refreshed;
}

async function getCodexCredentials(): Promise<CodexCredentials> {
  const creds = await readCodexCredentials();
  if (!isExpiringSoon(creds.expiresAt)) {
    return creds;
  }

  const refreshed = await refreshCodexCredentials(creds).catch(() => null);
  return refreshed ?? creds;
}

function buildCodexHeaders(creds: CodexCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "tsbot-codex",
    Accept: "application/json",
  };

  if (creds.accountId) {
    headers["ChatGPT-Account-Id"] = creds.accountId;
  }

  return headers;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted = { ...headers };
  if (redacted.Authorization) {
    redacted.Authorization = "Bearer <redacted>";
  }
  return redacted;
}

function logCodexRequest(body: CodexRequestBody, headers: Record<string, string>): void {
  if (!DEBUG_REQUEST) return;
  console.log("[codex] request");
  console.log(JSON.stringify({
    url: CODEX_RESPONSES_URL,
    method: "POST",
    headers: redactHeaders(headers),
    body,
  }, null, 2));
}

async function logCodexResponse(res: Response): Promise<void> {
  if (!DEBUG_REQUEST) return;
  const preview = await res.clone().text().catch(() => "");
  console.log("[codex] response");
  console.log(JSON.stringify({
    status: res.status,
    statusText: res.statusText,
    bodyPreview: preview.slice(0, 1000),
  }, null, 2));
}

function buildCodexRequest(model: string, systemPrompt: string, messages: LlmMessage[]): CodexRequestBody {
  const input = messages
    .filter((message) => message.content.trim())
    .map((message) => {
      const role: CodexInputItem["role"] = message.role === "assistant" ? "assistant" : "user";
      return {
        role,
        content: message.content.trim(),
      };
    });

  return {
    model,
    input,
    instructions: systemPrompt || undefined,
    store: false,
    stream: true,
    reasoning: model === "gpt-5.4" ? { effort: "medium" } : undefined,
  };
}

async function readCodexStreamText(res: Response): Promise<string> {
  const body = res.body;
  if (!body) {
    return "";
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let latestText = "";
  const accumulated: string[] = [];

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      if (event.type === "response.output_text.delta") {
        const delta = typeof event.delta === "string" ? event.delta : "";
        accumulated.push(delta);
        latestText = accumulated.join("");
      } else if (event.type === "response.output_text.done") {
        const text = typeof event.text === "string" ? event.text : "";
        if (text && text.length >= latestText.length) {
          latestText = text;
        }
      } else {
        const parsed = extractCodexText(event);
        if (parsed && parsed.length >= latestText.length) {
          latestText = parsed;
        }
      }
    }
  }

  return latestText.trim();
}

function extractCodexText(rawResult: unknown): string {
  if (!rawResult || typeof rawResult !== "object") return "";
  const root = rawResult as Record<string, unknown>;

  if (typeof root.output_text === "string" && root.output_text.trim()) {
    return root.output_text.trim();
  }

  const texts: string[] = [];

  const visitMessage = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    const item = obj as Record<string, unknown>;
    if (item.type !== "message" || !Array.isArray(item.content)) return;
    for (const part of item.content) {
      if (!part || typeof part !== "object") continue;
      const piece = part as Record<string, unknown>;
      if (typeof piece.text === "string") {
        texts.push(piece.text);
      }
    }
  };

  visitMessage(root.item);
  if (Array.isArray(root.output)) {
    for (const item of root.output) visitMessage(item);
  }

  const response = root.response;
  if (response && typeof response === "object") {
    const responseObj = response as Record<string, unknown>;
    if (typeof responseObj.output_text === "string" && responseObj.output_text.trim()) {
      return responseObj.output_text.trim();
    }
    if (Array.isArray(responseObj.output)) {
      for (const item of responseObj.output) visitMessage(item);
    }
  }

  return texts.join("").trim();
}

async function requestCodexText(model: string, systemPrompt: string, messages: LlmMessage[]): Promise<string> {
  let creds = await getCodexCredentials();
  const body = buildCodexRequest(model, systemPrompt, messages);
  let retriedFetchFailed = false;

  let authAttempt = 0;
  while (authAttempt < 2) {
    const headers = buildCodexHeaders(creds);
    headers.Accept = "text/event-stream";
    logCodexRequest(body, headers);
    let res: Response;
    try {
      res = await fetch(CODEX_RESPONSES_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (!retriedFetchFailed && isFetchFailedError(error)) {
        retriedFetchFailed = true;
        console.warn("Codex request fetch failed; retrying once.");
        continue;
      }
      throw error;
    }
    await logCodexResponse(res);

    if ((res.status === 401 || res.status === 403) && authAttempt === 0 && creds.refreshToken) {
      const refreshed = await refreshCodexCredentials(creds).catch(() => null);
      if (refreshed) {
        creds = refreshed;
        authAttempt += 1;
        continue;
      }
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`Codex API error ${res.status}: ${errorText || "<empty>"}`);
    }

    return readCodexStreamText(res);
  }

  throw new Error("Codex request failed after retry.");
}

export async function resolveLlmProfile(configPath: string, requestedProfileName?: string): Promise<ResolvedLlmProfile> {
  const config = await loadConfig(configPath);
  const llm = config.llm;
  if (!llm?.profiles || Object.keys(llm.profiles).length === 0) {
    throw new Error(`Missing 'llm.profiles' in ${configPath}.`);
  }

  const profileName = requestedProfileName?.trim() || llm.active?.trim();
  if (!profileName) {
    throw new Error(`Missing 'llm.active' in ${configPath}.`);
  }

  const profile = llm.profiles[profileName];
  if (!profile) {
    throw new Error(`LLM profile '${profileName}' not found in ${configPath}.`);
  }

  if (profile.provider !== "codex") {
    throw new Error(`Only 'codex' provider is supported. Found '${profile.provider}' for '${profileName}'.`);
  }

  const model = profile.model?.trim();
  if (!model) {
    throw new Error(`Missing 'model' for llm profile '${profileName}' in ${configPath}.`);
  }

  return {
    name: profileName,
    provider: "codex",
    model,
    systemPrompt: profile.system_prompt ?? llm.system_prompt ?? DEFAULT_SYSTEM_PROMPT,
  };
}

export async function listLlmProfiles(configPath: string): Promise<{
  active: string;
  profiles: LlmProfileSummary[];
}> {
  const config = await loadConfig(configPath);
  const llm = config.llm;
  if (!llm?.profiles || Object.keys(llm.profiles).length === 0) {
    throw new Error(`Missing 'llm.profiles' in ${configPath}.`);
  }

  const active = llm.active?.trim();
  if (!active) {
    throw new Error(`Missing 'llm.active' in ${configPath}.`);
  }

  const profiles = Object.entries(llm.profiles).map(([name, profile]) => {
    const model = profile.model?.trim();
    if (!model) {
      throw new Error(`Missing 'model' for llm profile '${name}' in ${configPath}.`);
    }

    if (profile.provider !== "codex") {
      throw new Error(`Only 'codex' provider is supported. Found '${profile.provider}' for '${name}'.`);
    }

    return {
      name,
      provider: "codex" as const,
      model,
      displayName: `${name} (${model})`,
    };
  });

  return {
    active,
    profiles,
  };
}

export async function setActiveLlmProfile(configPath: string, profileName: string): Promise<void> {
  const config = await loadConfig(configPath);
  const llm = config.llm;
  const target = profileName.trim();
  if (!target) {
    throw new Error("profileName is required.");
  }

  if (!llm?.profiles || !llm.profiles[target]) {
    throw new Error(`LLM profile '${target}' not found in ${configPath}.`);
  }

  config.llm = {
    ...llm,
    active: target,
  };

  await saveConfig(configPath, config);
}

export async function createLlmClient(configPath: string, requestedProfileName?: string): Promise<LlmClient> {
  const profile = await resolveLlmProfile(configPath, requestedProfileName);

  return {
    profileName: profile.name,
    provider: "codex",
    model: profile.model,
    systemPrompt: profile.systemPrompt,
    displayName: `${profile.name} (${profile.model})`,
    async generateText(input): Promise<string> {
      const { systemPrompt, contents } = splitSystemPrompt(
        input.messages,
        input.systemPrompt ?? profile.systemPrompt,
      );

      return requestCodexText(profile.model, systemPrompt, contents);
    },
  };
}
