# tsbot

`tsbot` is a local TypeScript service for receiving upstream chat events, deciding whether to reply with an LLM, and keeping a searchable memory trail in Qdrant.

This README intentionally avoids repository-specific personal details such as account names, target group identifiers, and custom persona text.

## 中文说明

`tsbot` 是一个本地运行的 TypeScript 消息服务，用来接收上游 WebSocket 消息、调用 LLM 判断是否需要回复，并把消息写入 Qdrant 以便后续检索和上下文记忆。

当前项目主要能力：

- 连接上游 WebSocket 消息源并处理收到的事件。
- 解析文本消息和部分媒体相关元数据。
- 将消息写入 Qdrant，支持按会话条件筛选查询。
- 基于可配置的 Codex 模型配置判断是否需要自动回复。
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

- 这个 README 有意不写账号名、群号、自定义人设提示词等个人或环境敏感信息。

## What the Project Does

- Connects to an upstream WebSocket message source.
- Parses incoming text and supported media metadata.
- Stores incoming messages in Qdrant for short-term memory and lookup.
- Uses a configurable Codex-backed LLM profile to decide whether a reply is needed.
- Sends generated replies back through the upstream WebSocket bridge.
- Exposes a local monitor page for connection state, message flow, model activity, and reconnect actions.
- Exposes a local memory browser for filtering and inspecting stored message records.

## Current Runtime Shape

The primary runtime is the TypeScript service in `main.ts`.

The service starts:

- An HTTP server on `127.0.0.1:5000`
- A WebSocket client that connects to `ws://127.0.0.1:8082`

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

- `codex` as the LLM provider
- Multiple named profiles
- Runtime profile switching
- Config reload when `config.yaml` changes

Message memory is backed by Qdrant. When enabled, the service:

- Creates the target collection if needed
- Stores each incoming message with payload metadata
- Supports filtered lookup by group, user, and message type
- Journals writes in `logs/qdrant-outbox/` before remote delivery, then
  automatically replays pending records after transient network failures or a
  process restart

## Requirements

- Node.js
- npm
- A reachable Qdrant instance if memory is enabled
- Valid Codex authentication available to the runtime

## Install and Run

Install dependencies:

```powershell
npm install
```

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
- `qdrant`: memory store settings such as URL, collection, and timeout
- `holly_bootstrap`: startup reflection and QQ lifecycle policy

A minimal example shape:

```yaml
admin:
  enabled: true
  # Or set HOLLY_ADMIN_QQ_IDS=12345678,87654321 outside the repository.
  user_ids: ["12345678"]
  force_reply: true # Applies only to authenticated administrator private chats.
  immediate_reply: true
  reply_while_observing: true
  code_improvement:
    enabled: true
    command_prefixes: ["/改进代码"]
    executable: codex
    apply_when_clean: true
    timeout_seconds: 1200

private_chat:
  enabled: true
  friends_only: true
  history_message_count: 40
  friend_refresh_minutes: 5
  # Or set HOLLY_BOT_QQ_ID outside the repository.
  bot_user_id: "10000002"

holly_bootstrap:
  enabled: true
  reflection_enabled: true
  # auto asks Holly after memory restoration; a fixed offline/observe/active
  # value acts as an operator override.
  qq_mode: auto
  fallback_qq_mode: observe
  reconsider_minutes: 60

llm:
  active: default
  profiles:
    default:
      provider: codex
      model: gpt-5.4

qdrant:
  enabled: true
  url: http://127.0.0.1:6333
  collection: ws_incoming_messages
  timeout_ms: 10000
```

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

- Session logs are written to the `logs/` directory.
- The repository also contains a Python file (`main.py`), but the active service described here is the TypeScript implementation.
- If you plan to share this repository, keep custom prompts, tokens, and environment-specific identifiers out of version control.
