import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerProvider } from "../llm-service.js";
import type { LLMContent, LLMRequest, LLMResponse, LLMTool, LLMToolCall } from "../../type/llm.js";
import type { ProviderUsage, UsageWindow } from "../../type/llm-provider.js";
import { makeLLMResponse, normalizeOpenAIUsage } from "../llm-response.js";

const KEYCHAIN_SERVICE = "Codex Auth";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_TIMEOUT_MS = 5000;
const PROJECT_AUTH_PATH = path.join(process.cwd(), ".codex", "auth.json");
const HOME_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const CODEX_AUTH_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
// Refresh tokens 5 minutes early to avoid expiry during a request.
const TOKEN_REFRESH_BUFFER_MS = 300_000;


/** Clamp a usage percentage into the 0..100 range. */
function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

/** Extract the JWT exp claim and return it as a millisecond timestamp. */
function parseJwtExp(jwt: string): number | null {
    try {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf-8'));
        return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    } catch {
        return null;
    }
}

/** Check whether a token is close enough to expiry that it should be refreshed now. */
function isExpiringSoon(expiresAt: number | null): boolean {
    return Date.now() + TOKEN_REFRESH_BUFFER_MS >= expiresAt;
}

/** Resolve the Codex home directory and normalize symlinks for keychain lookups. */
function resolveCodexHome(): string {
    const configured = process.env.CODEX_HOME;
    const home = configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
    try {
        return fs.realpathSync.native(home);
    } catch {
        return home;
    }
}

/** Reproduce the Codex CLI account naming used in macOS Keychain. */
function computeKeychainAccount(codexHome: string): string {
    const hash = createHash("sha256").update(codexHome).digest("hex");
    return `cli|${hash.slice(0, 16)}`;
}

type CredentialsSource = "project" | "keychain" | "home";

type CodexCredentials = {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
    accountId?: string;
    source: CredentialsSource;
    _rawTokens: Record<string, unknown>;
};

/** Parse an auth.json payload into the provider's normalized credential shape. */
function parseTokensPayload(raw: string, source: CredentialsSource): CodexCredentials {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const tokens = data.tokens as Record<string, unknown> | undefined;
    if (!tokens) throw new Error("tokens not found in auth.json");
    const accessToken = tokens.access_token;
    if (typeof accessToken !== "string" || !accessToken) throw new Error("access_token not found in auth.json");
    const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : null;
    const accountId = typeof tokens.account_id === "string" ? tokens.account_id : undefined;
    const expiresAt = parseJwtExp(accessToken);
    return { accessToken, refreshToken, expiresAt, accountId, source, _rawTokens: tokens };
}

/** Persist refreshed credentials into the project-local auth store. */
function writeProjectAuth(creds: CodexCredentials): void {
    const tokens = { ...creds._rawTokens, access_token: creds.accessToken, refresh_token: creds.refreshToken };
    const payload = JSON.stringify({ tokens });
    fs.mkdirSync(path.dirname(PROJECT_AUTH_PATH), { recursive: true });
    fs.writeFileSync(PROJECT_AUTH_PATH, payload, { encoding: "utf-8", mode: 0o600 });
}

/** Convert the credential source into a readable label for logs. */
function credentialsLocation(source: CredentialsSource): string {
    if (source === "project") return PROJECT_AUTH_PATH;
    if (source === "home") return HOME_AUTH_PATH;
    return "macOS Keychain";
}

/** Load credentials using project auth.json, macOS keychain, then home auth.json. */
function readCodexCredentials(): CodexCredentials {
    // Prefer project-local credentials so each repo can manage its own auth.
    try {
        return parseTokensPayload(fs.readFileSync(PROJECT_AUTH_PATH, "utf-8"), "project");
    } catch {
        // fall through to system stores
    }

    // macOS Keychain
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
            // fall through to home file
        }
    }

    // ~/.codex/auth.json
    return parseTokensPayload(fs.readFileSync(HOME_AUTH_PATH, "utf-8"), "home");
}

type CodexInputItem =
    | {
        role: 'user' | 'assistant';
        content: string | Array<
            | { type: 'input_text'; text: string }
            | { type: 'input_image'; image_url: string }
        >;
    }
    | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
    | { type: 'function_call_output'; call_id: string; output: string };

type CodexTool = {
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, unknown>;
};

type CodexTextFormat =
    | { type: 'text' }
    | { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean };

type CodexRequestBody = {
    model: string;
    input: CodexInputItem[];
    instructions?: string;
    store: false;
    stream?: boolean;
    tools?: CodexTool[];
    tool_choice?: 'auto';
    text?: {
        format: CodexTextFormat;
    };
    [key: string]: unknown;
};

type CodexToolCallState = {
    id: string;
    name: string;
    argsJson: string;
};


/** Adapt the app's generic LLM interface to ChatGPT Codex Responses APIs. */
export class CodexProvider {
    name: string = 'codex';
    private creds: CodexCredentials;
    // Deduplicate concurrent token refresh requests.
    private pendingRefresh: Promise<CodexCredentials | null> | null = null;
    // Claim project-local credentials when bootstrapping from system credentials.
    private initialClaim: Promise<void> | null = null;

    /** Initialize credentials and claim project-local credentials when needed. */
    constructor() {
        this.creds = readCodexCredentials();
        if (this.creds.source === "project") {
            console.log(`[CodexProvider] Loaded project credentials from ${PROJECT_AUTH_PATH}`);
        } else {
            console.warn(
                `[CodexProvider] No project credentials found; loading from ${credentialsLocation(this.creds.source)} and claiming project-local credentials.`
            );
            this.initialClaim = this.claimProjectCredentials();
        }
    }

    /** Refresh system credentials once and persist the result as project-local credentials. */
    private async claimProjectCredentials(): Promise<void> {
        console.log("[CodexProvider] Claiming project-local credentials from system credentials");
        const claimed = await this.doRefresh();
        if (!claimed || claimed.source !== "project") {
            throw new Error("Failed to create project-local Codex credentials from system credentials.");
        }
    }

    /** Exchange refresh_token for a new access_token and persist the result locally. */
    private async doRefresh(): Promise<CodexCredentials | null> {
        if (!this.creds.refreshToken) {
            console.warn("[CodexProvider] No refresh_token available; skipping refresh");
            return null;
        }

        if (this.pendingRefresh) return this.pendingRefresh;

        this.pendingRefresh = (async () => {
            try {
                const sourceBeforeRefresh = this.creds.source;
                const res = await fetch(CODEX_AUTH_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        grant_type: "refresh_token",
                        refresh_token: this.creds.refreshToken,
                        client_id: CODEX_CLIENT_ID,
                    }),
                    signal: AbortSignal.timeout(10_000),
                });

                if (!res.ok) {
                    const errorBody = await res.text();
                    console.warn(`[CodexProvider] Token refresh failed: HTTP ${res.status} body=${errorBody || "<empty>"}`);
                    return null;
                }

                const data = await res.json() as {
                    access_token: string;
                    refresh_token?: string;
                    expires_in?: number;
                    id_token?: string;
                };

                const expiresAt = data.expires_in
                    ? Date.now() + data.expires_in * 1000
                    : parseJwtExp(data.access_token);

                const newCreds: CodexCredentials = {
                    accessToken: data.access_token,
                    refreshToken: data.refresh_token ?? this.creds.refreshToken,
                    expiresAt,
                    accountId: this.creds.accountId,
                    source: "project",
                    _rawTokens: {
                        ...this.creds._rawTokens,
                        access_token: data.access_token,
                        refresh_token: data.refresh_token ?? this.creds.refreshToken,
                        ...(data.id_token && { id_token: data.id_token }),
                    },
                };

                this.creds = newCreds;

                try {
                    writeProjectAuth(newCreds);
                    if (sourceBeforeRefresh !== "project") {
                        console.warn(
                            "[CodexProvider] Wrote refreshed credentials to the project store. Re-login may be required in the system Codex client."
                        );
                    } else {
                        console.log("[CodexProvider] Token refresh succeeded and was written to local storage");
                    }
                } catch (e) {
                    console.warn("[CodexProvider] Failed to write refreshed token:", (e as Error).message);
                }

                return newCreds;
            } catch (e) {
                console.warn("[CodexProvider] Token refresh threw an error:", (e as Error).message);
                return null;
            }
        })();

        try {
            return await this.pendingRefresh;
        } finally {
            this.pendingRefresh = null;
        }
    }

    /** Wait for bootstrap work and refresh early if the current token is near expiry. */
    private async getToken(): Promise<string> {
        if (this.initialClaim) {
            try {
                await this.initialClaim;
            } finally {
                this.initialClaim = null;
            }
        }

        if (isExpiringSoon(this.creds.expiresAt)) {
            console.log("[CodexProvider] Token is expiring soon; attempting refresh");
            await this.doRefresh();
        }

        return this.creds.accessToken;
    }

    /** Build standard request headers for Codex backend calls. */
    private buildHeaders(token: string): Record<string, string> {
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'CodexBar',
            'Accept': 'application/json',
        };
        if (this.creds.accountId) {
            headers['ChatGPT-Account-Id'] = this.creds.accountId;
        }
        return headers;
    }

    /** Serialize tool arguments and tool outputs into the string form Codex expects. */
    private stringifyToolPayload(value: unknown): string {
        if (typeof value === 'string') return value;
        try {
            return JSON.stringify(value ?? {});
        } catch {
            return '{}';
        }
    }

    /** Normalize function call item ids into the character set Codex accepts. */
    private normalizeFunctionItemId(callId: string): string {
        const sanitized = callId.replace(/[^a-zA-Z0-9_-]/g, '_');
        return sanitized.startsWith('fc') ? sanitized : `fc_${sanitized}`;
    }

    /** Convert the app's generic tool schema into the Codex tool schema. */
    private convertTools(tools?: LLMTool[]): CodexTool[] | undefined {
        if (!tools || tools.length === 0) return undefined;
        return tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        }));
    }

    /** Ensure image content is sent to Codex as a data URL. */
    private toDataUrl(mimeType: string, data: string): string {
        if (data.startsWith('data:')) {
            return data;
        }
        return `data:${mimeType};base64,${data}`;
    }

    /** Extract image data from an LLMContent item and convert it into a URL Codex accepts. */
    private async contentToImageUrl(content: LLMContent): Promise<string | null> {
        if (content.inlineData?.mimeType && content.inlineData.data) {
            if (!content.inlineData.mimeType.startsWith('image/')) {
                return null;
            }
            return this.toDataUrl(content.inlineData.mimeType, content.inlineData.data);
        }

        if (content.fileData?.mimeType && content.fileData.blob) {
            if (!content.fileData.mimeType.startsWith('image/')) {
                return null;
            }
            const arrayBuffer = await content.fileData.blob.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString('base64');
            return this.toDataUrl(content.fileData.mimeType, base64);
        }

        return null;
    }

    /** Convert the app's messages into Codex input items, including tools and multimodal parts. */
    private async buildInput(request: LLMRequest): Promise<CodexInputItem[]> {
        const input: CodexInputItem[] = [];
        for (const msg of request.messages) {
            const role = msg.role === 'model' ? 'assistant' : 'user';
            const textOnly = msg.content.every(c => !c.inlineData && !c.fileData);
            if (textOnly) {
                // Collapse plain text content into a single string for Codex input.
                const text = msg.content.map(c => c.text ?? '').join('');
                if (text.trim()) {
                    input.push({ role, content: text });
                }
            } else {
                // Preserve text and image parts for multimodal Codex input.
                const parts: Array<
                    | { type: 'input_text'; text: string }
                    | { type: 'input_image'; image_url: string }
                > = [];
                for (const c of msg.content) {
                    if (c.text && c.text.trim()) {
                        parts.push({ type: 'input_text', text: c.text });
                    }
                    const imageUrl = await this.contentToImageUrl(c);
                    if (imageUrl) {
                        parts.push({ type: 'input_image', image_url: imageUrl });
                    }
                }
                if (parts.length > 0) {
                    input.push({ role, content: parts });
                }
            }
            // Tool calls and tool outputs are sent as standalone items after the message.
            for (const c of msg.content) {
                if (c.tool_call) {
                    const callId = c.tool_call.id;
                    input.push({
                        type: 'function_call',
                        id: this.normalizeFunctionItemId(callId),
                        call_id: callId,
                        name: c.tool_call.name,
                        arguments: this.stringifyToolPayload(c.tool_call.args),
                    });
                } else if (c.tool_resp) {
                    input.push({
                        type: 'function_call_output',
                        call_id: c.tool_resp.id,
                        output: this.stringifyToolPayload(c.tool_resp.response),
                    });
                }
            }
        }
        return input;
    }

    /** Build the Codex Responses API request body from the app's generic LLM request. */
    private async buildRequestBody(request: LLMRequest, stream: boolean): Promise<CodexRequestBody> {
        const {
            model,
            messages,
            system,
            responseSchema,
            tools: requestTools,
            ...otherParams
        } = request;
        // timeout/retry are local controls and should not be forwarded to Codex.
        delete otherParams.timeout;
        delete otherParams.retry;
        const body: CodexRequestBody = {
            model,
            input: await this.buildInput({
                ...request,
                model,
                messages,
                system,
                responseSchema,
                tools: requestTools,
            }),
            store: false,
        };
        if (system) {
            body.instructions = system;
        }
        const tools = this.convertTools(requestTools);
        if (tools && tools.length > 0) {
            // Allow the model to decide when a tool call is needed.
            body.tools = tools;
            body.tool_choice = 'auto';
        }
        if (responseSchema) {
            // Convert structured output requirements to Codex json_schema format.
            body.text = {
                format: {
                    type: 'json_schema',
                    name: 'output_format',
                    schema: responseSchema,
                    strict: true,
                }
            };
        }
        if (stream) {
            body.stream = true;
        }
        return {
            ...body,
            ...otherParams,
        };
    }

    /** Normalize tool arguments from either object or JSON-string input. */
    private parseToolCallArgs(value: unknown): Record<string, unknown> {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed as Record<string, unknown>;
                }
            } catch {
                return {};
            }
        }
        return {};
    }

    /** Parse a single Codex output item into a normalized tool call. */
    private parseToolCallFromItem(item: Record<string, unknown>): LLMToolCall | null {
        const type = typeof item.type === 'string' ? item.type : '';
        const isToolCallType = type === 'function_call' || type === 'tool_call' || type === 'custom_tool_call';
        if (!isToolCallType) return null;
        const id = typeof item.call_id === 'string'
            ? item.call_id
            : typeof item.id === 'string'
                ? item.id
                : '';
        const name = typeof item.name === 'string'
            ? item.name
            : typeof item.tool_name === 'string'
                ? item.tool_name
                : '';
        if (!id || !name) return null;
        const args = this.parseToolCallArgs(item.arguments ?? item.args);
        return { id, name, args };
    }

    /** Collect tool calls from the different response shapes Codex may emit. */
    private parseToolCalls(rawResult: unknown): LLMToolCall[] {
        if (!rawResult || typeof rawResult !== 'object') return [];
        const root = rawResult as Record<string, unknown>;
        const calls: LLMToolCall[] = [];
        const seen = new Set<string>();
        const pushCall = (call: LLMToolCall | null) => {
            if (!call) return;
            if (seen.has(call.id)) return;
            seen.add(call.id);
            calls.push(call);
        };

        const arrays: unknown[] = [];
        // Codex may expose output arrays at the root or under response.
        if (Array.isArray(root.output)) arrays.push(root.output);
        if (Array.isArray(root.tool_calls)) arrays.push(root.tool_calls);

        const response = root.response;
        if (response && typeof response === 'object') {
            const responseObj = response as Record<string, unknown>;
            if (Array.isArray(responseObj.output)) arrays.push(responseObj.output);
            if (Array.isArray(responseObj.tool_calls)) arrays.push(responseObj.tool_calls);
        }

        const item = root.item;
        if (item && typeof item === 'object') {
            pushCall(this.parseToolCallFromItem(item as Record<string, unknown>));
        }

        for (const arr of arrays) {
            if (!Array.isArray(arr)) continue;
            for (const entry of arr) {
                if (!entry || typeof entry !== 'object') continue;
                pushCall(this.parseToolCallFromItem(entry as Record<string, unknown>));
            }
        }

        return calls;
    }

    /** Extract known text fragments from a raw response or an SSE event object. */
    private parseTextFromRaw(rawResult: unknown): string {
        if (!rawResult || typeof rawResult !== 'object') return '';
        const root = rawResult as Record<string, unknown>;
        const texts: string[] = [];
        const visitMessage = (obj: unknown) => {
            if (!obj || typeof obj !== 'object') return;
            const item = obj as Record<string, unknown>;
            if (item.type !== 'message' || !Array.isArray(item.content)) return;
            for (const part of item.content) {
                if (!part || typeof part !== 'object') continue;
                const p = part as Record<string, unknown>;
                if (typeof p.text === 'string') texts.push(p.text);
            }
        };

        visitMessage(root.item);
        if (Array.isArray(root.output)) {
            for (const item of root.output) visitMessage(item);
        }
        const response = root.response;
        if (response && typeof response === 'object') {
            const responseObj = response as Record<string, unknown>;
            if (Array.isArray(responseObj.output)) {
                for (const item of responseObj.output) visitMessage(item);
            }
        }
        return texts.join('');
    }

    /** Wrap text, tool calls, raw payload, and usage into the shared LLMResponse shape. */
    private makeResponse(text: string, rawResult: unknown, parsedToolCalls?: LLMToolCall[]): LLMResponse {
        const toolCalls = parsedToolCalls ?? this.parseToolCalls(rawResult);
        const content: LLMContent[] = [];
        if (text) content.push({ text });
        for (const toolCall of toolCalls) {
            content.push({ tool_call: toolCall });
        }
        const usage = rawResult && typeof rawResult === "object"
            ? normalizeOpenAIUsage((rawResult as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage)
            : undefined;
        return makeLLMResponse(content, rawResult, usage);
    }

    /** Fetch Codex usage data and normalize it into the shared provider usage shape. */
    async fetchUsage(): Promise<ProviderUsage> {
        const token = await this.getToken();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
        try {
            const res = await fetch(CODEX_USAGE_URL, {
                headers: this.buildHeaders(token),
                signal: controller.signal,
            });
            if (!res.ok) {
                throw new Error(`Codex usage API error ${res.status}`);
            }
            const data = await res.json() as {
                rate_limit?: {
                    primary_window?: { limit_window_seconds?: number; used_percent?: number; reset_at?: number };
                    secondary_window?: { limit_window_seconds?: number; used_percent?: number; reset_at?: number };
                };
                plan_type?: string;
                credits?: { balance?: number | string | null };
            };
            const windows: UsageWindow[] = [];
            if (data.rate_limit?.primary_window) {
                const pw = data.rate_limit.primary_window;
                const hours = Math.round((pw.limit_window_seconds ?? 10800) / 3600);
                windows.push({
                    label: `${hours}h`,
                    usedPercent: clampPercent(pw.used_percent ?? 0),
                    resetAt: pw.reset_at ? pw.reset_at * 1000 : undefined,
                });
            }
            if (data.rate_limit?.secondary_window) {
                const sw = data.rate_limit.secondary_window;
                const hours = Math.round((sw.limit_window_seconds ?? 86400) / 3600);
                windows.push({
                    label: hours == 168 ? 'Week' : `${hours}h`,
                    usedPercent: clampPercent(sw.used_percent ?? 0),
                    resetAt: sw.reset_at ? sw.reset_at * 1000 : undefined,
                });
            }
            let plan = data.plan_type;
            if (data.credits?.balance != null) {
                const balance = typeof data.credits.balance === 'number'
                    ? data.credits.balance
                    : parseFloat(data.credits.balance) || 0;
                plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
            }
            return { windows, plan };
        } finally {
            clearTimeout(timer);
        }
    }

    /** Reuse the streaming implementation and return only the final accumulated response. */
    async generateContent(request: LLMRequest): Promise<LLMResponse> {
        const stream = await this.generateContentStream(request);
        let last: LLMResponse | undefined;
        for await (const chunk of stream) {
            last = chunk;
        }
        if (!last) {
            return this.makeResponse('', undefined);
        }
        return last;
    }

    /** Start a streaming Codex request and translate SSE events into LLMResponse snapshots. */
    async generateContentStream(request: LLMRequest): Promise<AsyncGenerator<LLMResponse>> {
        const controller = new AbortController();
        const timer = request.timeout
            ? setTimeout(() => controller.abort(), request.timeout)
            : undefined;

        const token = await this.getToken();
        const res = await fetch(CODEX_RESPONSES_URL, {
            method: 'POST',
            headers: { ...this.buildHeaders(token), 'Accept': 'text/event-stream' },
            body: JSON.stringify(await this.buildRequestBody(request, true)),
            signal: controller.signal,
        });


        if (!res.ok) {
            if (timer !== undefined) clearTimeout(timer);
            const text = await res.text().catch(() => '');
            throw new Error(`Codex API error ${res.status}: ${text}`);
        }

        const body = res.body!;
        const self = this;

        return (async function* () {
            const accumulated: string[] = [];
            const toolCallState = new Map<string, CodexToolCallState>();
            const snapshotToolCalls = (): LLMToolCall[] => {
                // The same tool call may be tracked by item_id, call_id, and call.id.
                const dedup = new Map<string, LLMToolCall>();
                for (const state of toolCallState.values()) {
                    dedup.set(state.id, {
                        id: state.id,
                        name: state.name,
                        args: self.parseToolCallArgs(state.argsJson),
                    });
                }
                return Array.from(dedup.values());
            };
            const decoder = new TextDecoder();
            let buffer = '';
            let latestText = '';

            try {
                for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
                    buffer += decoder.decode(chunk, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';

                    for (const line of lines) {
                        // Ignore non-data SSE lines.
                        if (!line.startsWith('data: ')) continue;
                        const payload = line.slice(6).trim();
                        if (payload === '[DONE]') return;

                        let event: Record<string, unknown>;
                        try {
                            event = JSON.parse(payload);
                        } catch {
                            continue;
                        }

                        if (event.type === 'response.output_text.delta') {
                            // Append text deltas and emit the latest snapshot.
                            const delta = typeof event.delta === 'string' ? event.delta : '';
                            accumulated.push(delta);
                            latestText = accumulated.join('');
                            yield self.makeResponse(latestText, event, snapshotToolCalls());
                        } else if (event.type === 'response.output_text.done') {
                            // Prefer the server's completed text over local reconstruction.
                            const text = typeof event.text === 'string' ? event.text : '';
                            if (text && text.length >= latestText.length) {
                                latestText = text;
                            }
                            yield self.makeResponse(latestText, event, snapshotToolCalls());
                        } else if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
                            // Output items may carry text snapshots and initial tool call metadata.
                            const parsedText = self.parseTextFromRaw(event);
                            if (parsedText && parsedText.length >= latestText.length) {
                                latestText = parsedText;
                            }
                            const call = self.parseToolCalls(event)[0];
                            if (call) {
                                const item = (event.item && typeof event.item === 'object')
                                    ? event.item as Record<string, unknown>
                                    : null;
                                const itemId = typeof item?.id === 'string' ? item.id : '';
                                const callId = typeof item?.call_id === 'string' ? item.call_id : '';
                                const old = toolCallState.get(itemId || callId || call.id);
                                const argsJson = old ? old.argsJson : JSON.stringify(call.args ?? {});
                                const state: CodexToolCallState = { id: call.id, name: call.name, argsJson };
                                if (itemId) toolCallState.set(itemId, state);
                                if (callId) toolCallState.set(callId, state);
                                toolCallState.set(call.id, state);
                            }
                            yield self.makeResponse(latestText, event, snapshotToolCalls());
                        } else if (event.type === 'response.function_call_arguments.delta') {
                            // Tool arguments can stream in chunks and must be reassembled.
                            const itemId = typeof event.item_id === 'string' ? event.item_id : '';
                            const delta = typeof event.delta === 'string' ? event.delta : '';
                            if (!itemId || !delta) continue;
                            const prev = toolCallState.get(itemId);
                            if (!prev) continue;
                            prev.argsJson += delta;
                            toolCallState.set(itemId, prev);
                        } else if (event.type === 'response.function_call_arguments.done') {
                            // Replace the accumulated value with the final arguments payload.
                            const itemId = typeof event.item_id === 'string' ? event.item_id : '';
                            if (!itemId) continue;
                            const prev = toolCallState.get(itemId);
                            if (!prev) continue;
                            if (typeof event.arguments === 'string') {
                                prev.argsJson = event.arguments;
                            }
                            toolCallState.set(itemId, prev);
                            yield self.makeResponse(latestText, event, snapshotToolCalls());
                        } else if (event.type === 'response.completed') {
                            // Final event reconciles the completed text and tool call state.
                            const parsedText = self.parseTextFromRaw(event);
                            if (parsedText && parsedText.length >= latestText.length) {
                                latestText = parsedText;
                            }
                            const parsedCalls = self.parseToolCalls(event);
                            for (const call of parsedCalls) {
                                const state: CodexToolCallState = {
                                    id: call.id,
                                    name: call.name,
                                    argsJson: JSON.stringify(call.args ?? {}),
                                };
                                toolCallState.set(call.id, state);
                            }
                            yield self.makeResponse(latestText, event, snapshotToolCalls());
                        }
                    }
                }
            } finally {
                if (timer !== undefined) clearTimeout(timer);
            }
        })();
    }
}

/** Register the Codex provider with the shared LLM service. */
registerProvider(() => new CodexProvider(), false);
