# Holly

Licensed under the [MIT License](LICENSE). The bundled Vue runtime retains its
own copyright and [MIT license](vendor/VUE-LICENSE.txt).

Holly is a local TypeScript service for receiving upstream chat events, deciding whether to reply with an LLM, and keeping a searchable memory trail in SQLite or Qdrant.

Real account IDs, service endpoints, credentials and persona text belong in the ignored local `config.yaml` and `.env` files. Only sanitized examples are tracked by Git.

## 中文说明

Holly 是一个本地运行的 TypeScript 消息服务，用来接收上游 WebSocket 消息、调用 LLM 判断是否需要回复，并把消息写入 SQLite 或 Qdrant 以便后续检索和上下文记忆。

当前项目主要能力：

- 连接上游 WebSocket 消息源并处理收到的事件。
- 解析文本消息和部分媒体相关元数据。
- 将消息写入 SQLite 或 Qdrant，支持按会话条件筛选查询。
- 基于可配置的 Codex / Claude 模型判断是否需要自动回复。
- QQ 对话遇到最新或不确定的外部事实时可调用本地 SearXNG 联网搜索；“搜一下/查一下”等明确请求会强制走搜索链路，并可沿用上一条话题。
- 通过 OneBot `user_id` 白名单认证管理员；管理员私聊强制回复，群聊中按普通消息规则判断是否回复。
- 支持管理员用 `/改进代码 <要求>` 创建隔离、可审计的代码改进任务。
- 提供本地监控页面，查看连接状态、消息流和模型调用情况。
- 提供思考时间线；每分钟自主检查都会展示检查项目、结果和未行动原因。
- 提供本地记忆浏览页面，查看最近存储的消息记录。

本地启动后可访问：

- `http://127.0.0.1:5000/ws` 查看监控页面。
- `http://127.0.0.1:5000/thoughts` 查看思考时间线和每分钟自主检查。
- `http://127.0.0.1:5000/memories` 查看记忆查询页面。

说明：

- 首次运行先执行 `cp config.example.yaml config.yaml`，再把真实 QQ 号、群号、服务地址、凭据和人设填入本地 `config.yaml`。需要环境变量时再执行 `cp .env.example .env`；已有配置不要覆盖。
- `config.yaml` 和 `.env` 不提交 Git；只提交 `.example` 模板。监控页的设置仍写回本地 `config.yaml`。
- 示例默认只读、QQ 离线，管理员、自修改和自主任务均关闭。配置好账号与服务后，再按需启用各项能力。

## What the Project Does

- Connects to an upstream WebSocket message source.
- Parses incoming text and supported media metadata.
- Stores incoming messages in SQLite or Qdrant for short-term memory and lookup.
- Uses a configurable Codex or Claude LLM profile to decide whether a reply is needed.
- Sends generated replies back through the upstream WebSocket bridge.
- Exposes a local monitor page for connection state, message flow, model activity, and reconnect actions.
- Exposes a local memory browser for filtering and inspecting stored message records.

## Current Runtime Shape

The primary runtime is the TypeScript service in `main.ts`.

The service starts:

- An HTTP server on `127.0.0.1:5000`
- A WebSocket client that connects to the configured NapCat/OneBot endpoint when QQ mode is `observe` or `active` (the example starts `offline`)

Available local pages and APIs:

- `GET /` or `GET /ws`: monitor UI
- `GET /thoughts`: thought timeline, including the once-per-minute autonomy check
- `GET /memories`: memory browser UI
- `GET /api/ws/events`: server-sent event stream for monitor updates
- `GET /api/memories`: recent stored messages with filters
- `GET /api/llm/profiles`: available LLM profiles and the active profile
- `POST /api/llm/active`: switch the active LLM profile
- `POST /api/ws/reconnect`: force the upstream WebSocket client to reconnect

## LLM and Memory

LLM configuration is loaded from `config.yaml`.

Current TypeScript implementation supports:

- `codex` and `claude` as LLM providers
- Multiple named profiles
- Runtime profile switching
- Config reload when `config.yaml` changes

The example uses local SQLite memory; see [local database configuration](LOCAL_DATABASE.md). Qdrant is optional. When Qdrant is selected and enabled, the service:

- Creates the target collection if needed
- Stores each incoming message with payload metadata
- Supports filtered lookup by group, user, and message type
- Journals writes in `logs/qdrant-outbox/` before remote delivery, then
  automatically replays pending records after transient network failures or a
  process restart

## Requirements

- Node.js 26 or newer
- npm
- A NapCat/OneBot WebSocket endpoint for QQ participation
- A reachable Qdrant instance only if that memory backend is selected
- Authentication for the selected Codex or Claude provider before enabling model calls

## Install and Run

Install dependencies and create local configuration files (skip the copy commands if you already have local files):

```powershell
npm ci
cp config.example.yaml config.yaml
# Optional environment variables:
cp .env.example .env
```

Edit `config.yaml` with your own settings. It is the only YAML file the runtime
loads and the monitor updates; `config.example.yaml` is never loaded as a fallback.
If the local file is missing, startup stops with a setup hint.

The example uses local SQLite and keeps QQ offline and read-only. Before joining
QQ, configure `napcat.ws_url`, `napcat.access_token` and `private_chat.bot_user_id`.
Set `holly_bootstrap.qq_mode` to `observe` to receive without replying, or to
`active` with `read_only: false` when you want replies. Enable ordinary private
chat, administrator actions and autonomous tasks separately as needed. Add real
administrator IDs, group targets and custom persona text only to `config.yaml`.

For Claude, choose a Claude profile for `llm.active` / `llm.decision_profile`
and use the login URL printed at startup. Codex uses the locally configured
Codex authentication; set `focus_mode.enabled: false` for Codex, since the focus
tool loop currently requires Claude. Search and browser observation require separate local
services; keep them disabled until configured.

Run in development mode:

```powershell
npm run dev
```

Build the TypeScript output:

```powershell
npm run build
```

Run the compiled app:

```powershell
npm start
```

Smoke-test the configured LLM profile:

```powershell
npm run llm:test
```

After startup, open:

- `http://127.0.0.1:5000/ws` for the monitor page
- `http://127.0.0.1:5000/memories` for the memory browser

## Configuration

Relevant `config.yaml` sections include:

- `admin`: QQ administrator allowlist, private-chat mandatory-reply policy, and controlled code-improvement runner
- `private_chat`: ordinary friend-private-chat ingestion, friend verification, history depth, and Holly's own QQ id
- `llm`: active profile, provider, model, and prompt configuration
- `napcat`: OneBot WebSocket endpoint and access token
- `database`: memory backend selection; SQLite is the example default
- `qdrant`: memory store settings such as URL, collection, and timeout
- `holly_bootstrap`: startup reflection and QQ lifecycle policy

The complete public templates are [config.example.yaml](config.example.yaml)
and [.env.example](.env.example). Numeric IDs in source examples and tests are
synthetic fixtures, not deployment defaults.

Optional environment variables in `.env`:

- `QDRANT_API_KEY`: overrides `qdrant.api_key` in the local YAML file.
- `HOLLY_ADMIN_QQ_IDS`: comma-separated administrator IDs, added to `admin.user_ids`.
- `HOLLY_BOT_QQ_ID`: overrides `private_chat.bot_user_id`.
- `SEARXNG_URL`: search endpoint, defaulting to `http://127.0.0.1:8888`.

`npm run dev`, `npm start` and PM2 load `.env` automatically. Never put real
credentials or deployment identifiers into the templates, test fixtures or
documentation. Do not force-add the ignored local files. Existing installations
keep using their current `config.yaml` without copying the template again.

Administrator identity is taken only from the numeric `user_id` in the
incoming OneBot event. Nicknames and text claiming to be an administrator do
not grant permission. Only authenticated administrator private messages bypass
ordinary reply selection and are scheduled immediately. Administrator group
messages keep their command permissions but use the same reply-selection,
staleness, batching, and QQ-mode rules as other group messages. If a mandatory
private reply cannot fulfill the requested action, Holly replies with the
reason. The operator `read_only` switch remains a hard emergency stop for all
QQ sends and self-modification.

Ordinary private messages are accepted only from users returned by NapCat's
`get_friend_list` when `friends_only` is enabled. Each friend is isolated under
the conversation key `private:<user_id>`, receives its own recent-history
bootstrap through `get_friend_msg_history`, memory retrieval, reply queue, and
prompt-cache prefix. A private message is a direct utterance to Holly but does
not grant administrator privileges. Replies use `send_private_msg`; ordinary
private replies follow the group-chat sending restrictions, while an
authenticated administrator private reply may also be sent in observe mode
when `reply_while_observing` is enabled. Read-only mode always suppresses it.

`/改进代码 <要求>` runs Codex in a detached git worktree with a workspace-write
sandbox. Holly records every job in `logs/admin-code-improvements.jsonl`, runs
the full test suite and TypeScript build, and applies the generated patch only
when protected files were untouched and the main worktree is still clean at
the same commit. Otherwise it keeps an audited patch under
`logs/admin-code-improvements/` and reports why it was not applied. Applying a
patch never restarts the running service automatically.

QQ runtime modes are `offline` (no connection), `observe` (connect and persist
messages without replying), and `active` (normal participation). Bootstrap model
or storage failures fall back to the configured mode instead of blocking startup.

## Notes

- The former AIRadar-derived AI-tone classifier and model weights have been removed because redistribution permission could not be established. AI-tone scoring is no longer available; old `ai_tone` settings are ignored.

- Session logs are written to the `logs/` directory.
- The repository also contains a Python file (`main.py`), but the active service described here is the TypeScript implementation.
- If you plan to share this repository, keep custom prompts, tokens, and environment-specific identifiers out of version control.
- Ignoring a file protects future commits; it does not remove data from existing Git history. Historical cleanup is a separate operation.
- The dashboard bundles Vue 3.5.38, copyright Yuxi (Evan) You and Vue contributors, under the [MIT license](vendor/VUE-LICENSE.txt). Source: [vuejs/core](https://github.com/vuejs/core/tree/v3.5.38).

## Deployment boundary

The dashboard is a local operator interface. It listens on `127.0.0.1:5000`
and has no authentication; it can display chat history and change runtime
settings. Do not expose it with a public reverse proxy or bind it to a public
interface. For remote access, use a private SSH tunnel.

Chat messages and model context are stored in the ignored `data/` and `logs/`
directories and sent to the configured LLM provider as needed. Configure QQ
participation and message retention with the people using the bot in mind.

## Contributing

Copy the example configuration only if you need to run the service. Tests and
builds work without `config.yaml`, `.env`, QQ access or provider credentials:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

Use synthetic IDs in tests and remove personal data from issue reports, logs
and screenshots. Pull requests run the same checks in GitHub Actions.
