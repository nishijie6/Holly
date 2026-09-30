# First startup

Holly runs locally on Node.js 26 or newer. Start with its offline example;
enable QQ participation and model calls only after your own services are ready.

## Install and start offline

```sh
git clone https://github.com/nishijie6/Holly.git
cd Holly
node --version
npm ci
cp config.example.yaml config.yaml
cp .env.example .env
npm run dev
```

On Windows PowerShell, use `Copy-Item config.example.yaml config.yaml` and
`Copy-Item .env.example .env` for the copy steps. Existing installations should
keep their local files instead of copying over them.

Open http://127.0.0.1:5000/ws. The example starts QQ in `offline` mode, with
`read_only: true`, administrator actions and autonomous tasks disabled. Memory
uses SQLite at `data/sqlite/holly.db`; Qdrant is optional. Stopping development
mode with Ctrl+C preserves runtime state in the local data/log directories.

For compiled mode, run `npm run build` followed by `npm start` from the repository
root. The build includes the required prompt text in `dist/prompts/`. Keep the
local configuration and bundled `vendor/` directory at the repository root.

The monitor is an operator interface with access to chat history and settings.
Its HTTP listener stays on loopback. For remote administration, use a private
SSH tunnel rather than exposing port 5000 to the internet.

## Authenticate the selected model

The example selects `claude_sonnet` for both `llm.active` and
`llm.decision_profile`. After starting Holly, open
http://localhost:5000/oauth/claude/login and complete the provider login.
Holly stores its own login in the ignored `.claude-oauth/` directory.
Authentication and model availability depend on the provider and your account;
Holly does not include an account, subscription, token or API key.

For Codex, authenticate your locally installed Codex CLI first, then select the
`codex` profile for both model roles and set `focus_mode.enabled: false` in your
local `config.yaml`. Holly uses the local Codex authentication store, including
`CODEX_HOME` when configured. The focus tool loop currently requires Claude.

To check the configured model before connecting QQ:

```sh
npm run llm:test
```

This check makes a real model request and uses your account's quota.

## Connect QQ

Install and configure a OneBot-compatible bridge such as
[NapCat](https://napneko.github.io/). Its installation and QQ login are separate
from Holly. Enable the bridge's forward WebSocket server, and put its actual
endpoint and access token in your local `config.yaml`:

```yaml
napcat:
  ws_url: ws://127.0.0.1:8082
  access_token: "YOUR_LOCAL_ACCESS_TOKEN"
private_chat:
  bot_user_id: "YOUR_BOT_QQ_ID"
```

These placeholders must be replaced locally. Endpoint and token must match the
bridge; do not publish real account IDs, group targets or login screenshots.

Start by setting `holly_bootstrap.qq_mode: observe` while keeping
`read_only: true`. This connects and stores incoming messages without sending
replies. Confirm that the monitor receives events and that SQLite records appear.
For replies, set `holly_bootstrap.qq_mode: active` and `read_only: false`.
Changes are reloaded by the service; restart after changing `napcat` settings,
which are read at process startup.

Ordinary friend private chat is enabled separately with
`private_chat.enabled: true`; keep `friends_only: true` for friend verification.
Administrator actions require both `admin.enabled: true` and a real numeric
`admin.user_ids` allowlist. Code improvement is a further opt-in under
`admin.code_improvement.enabled`. Autonomous actions and broadcast group
targets are also configured individually; the public example enables none.

## Optional search, browser and memory services

Search uses a separately installed [SearXNG](https://docs.searxng.org/admin/installation.html)
instance. Set `SEARXNG_URL` in `.env` (default `http://127.0.0.1:8888`) and enable
`search.enabled` only after that instance is working. SearXNG must permit JSON
search results. Holly's npm start/dev commands load `.env` automatically.

Browser observation launches a local Chrome, Chromium or Edge executable. Enable
`browser_agent.enabled` and, if automatic discovery fails, set
`browser_agent.executable_path` in local YAML or `BROWSER_AGENT_CHROME_PATH` in
`.env`. This runs a browser process; it does not supply a cloud browsing service.

For Qdrant memory, change `database.provider` to `qdrant`, enable `qdrant`, and
configure your own URL and `QDRANT_API_KEY`. SQLite setup and the read-only
Qdrant-to-SQLite migration are described in [LOCAL_DATABASE.md](../LOCAL_DATABASE.md).

## Common startup problems

| Symptom | Check |
| --- | --- |
| Missing `config.yaml` | Copy `config.example.yaml` once and fill it in locally. |
| `node:sqlite` or Node option errors | Use Node.js 26 or newer, as required by `package.json`. |
| Port 5000 already in use | Stop the other process using that port; avoid running two Holly instances. |
| Claude login required / rejected | Use Holly's login URL above; check your provider account and chosen model. |
| Focus tool loop unsupported for Codex | Set `focus_mode.enabled: false` or select Claude for both roles. |
| No QQ events / WebSocket reconnects | Check the bridge, endpoint, access token and QQ mode. |
| Events received but no replies | Check `observe`/`offline`, read-only mode and model authentication. |
| Search returns 403 or no results | Check the local SearXNG instance and whether JSON output is enabled. |
| No Chrome/Edge executable found | Set the browser executable path above. |

For bug reports, include versions, reproduction steps and a sanitized error
message. Keep tokens, `.env`, `config.yaml`, private messages and database files
out of issues and attachments. See [CONTRIBUTING.md](../CONTRIBUTING.md).
