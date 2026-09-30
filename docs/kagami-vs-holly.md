# Kagami 与 Holly 的实现对比

对比对象：`/path/to/kagami` 与 `/path/to/Holly`（本仓库）。
方法：结论一律回到源码核实，文件引用格式为 `路径:行号`。文档（README / ARCHITECTURE.md）只作导航线索，
凡与代码冲突处单列一节说明。

本文是历史实现快照。配置隐私一节已随本地配置迁移更新；示例中的账号、群号与路径均为占位值。

开源准备更新：Holly 的 AIRadar 衍生实现和模型权重因再分发授权未确认而移除；
下文 ai-tone 的对比仅描述旧版本，不代表当前版本包含该能力。

---

## 执行摘要

**先纠正一个前提。** 调研任务给出的假设是「kagami 很可能是 Holly 的架构重写版本」。**代码与 git 历史证明方向相反，
而且两者根本不是同一个项目的两个版本，是两个作者的两个独立项目：**

| | kagami | Holly |
| --- | --- | --- |
| remote | `github.com/Hei-AI/kagami` | `github.com/nishijie6/Holly` |
| 作者 | Kisin Wen（1419 commits，唯一作者） | Frank Paul / nishijie6（44 commits） |
| 首个 commit | 2025-08-22 `feat: 初始化项目代码库` | 2026-04-19 `Initial commit` |
| 最新 commit | 2026-07-11 | 2026-08-22 |

Holly 比 kagami **晚 8 个月起步**，且至今仍在演进；kagami 在 Holly 起步时已积累了 8 个月、数百次提交。
更直接的证据是 Holly 的源码里**显式把 Kagami 当参考实现引用**：

- [`Holly/LOCAL_DATABASE.md:3`](../../Holly/LOCAL_DATABASE.md) —「Holly 可以**像 Kagami 一样**使用进程内 SQLite 文件作为主要记忆库」
- [`Holly/llm-client.ts:757`](../../Holly/llm-client.ts) —「Top-level automatic caching (**kagami parity**, see claude-code-request.ts…)」——
  连注释里指向的文件名 `claude-code-request.ts` 都是 kagami 的文件（[`packages/llm-client/src/providers/claude-code-request.ts`](../packages/llm-client/src/providers/claude-code-request.ts)），Holly 自己没有这个文件
- [`Holly/main.ts:2259`](../../Holly/main.ts) —「Match **Kagami's** fail-closed boundary for unknown private senders」
- [`Holly/main.ts:3032`](../../Holly/main.ts) —「Single-group focus (**Kagami-style** "current conversation")」
- [`Holly/main.ts:3052`](../../Holly/main.ts) —「mirrors **Kagami's NotificationCenter**」——对应 kagami 的 [`apps/agent/src/agent/runtime/root-agent/notification/notification-center.ts`](../apps/agent/src/agent/runtime/root-agent/notification/notification-center.ts)
- [`Holly/main.ts:6978`](../../Holly/main.ts) —「**Kagami-style** private boundary」

反向搜索：kagami 全仓库无任何 "Holly" / "pybot" 字样。**影响是单向的：Holly 借鉴 Kagami，不是 Kagami 重写 Holly。**

在纠正过的前提下，最本质的五点差异：

1. **推理范式不同，这是最深的一条鸿沟。** kagami 是**带工具调用的 ReAct agent**：`LlmMessage` 有 `user/assistant/tool`
   三态、`toolCalls` 字段、66 个 `.tool.ts` 工具（[`packages/llm/src/index.ts:79-82`](../packages/llm/src/index.ts)）。
   Holly 的 LLM 层**完全没有工具调用**——`grep -c "tool" Holly/llm-client.ts` 返回 **0**，`LlmMessage` 只有
   `system/user/assistant`（[`Holly/llm-client.ts:10-17`](../../Holly/llm-client.ts)），唯一的模型出口是
   `generateText({messages, systemPrompt, jsonSchema}) => Promise<string>`（[`Holly/llm-client.ts:50-61`](../../Holly/llm-client.ts)）。
   Holly 的「智能」全部压在**一次结构化 JSON 决策**里：
   `{should_reply, final_answer, thinking_process, need_search, search_query}`（[`Holly/decision-prompt.ts:41-55`](../../Holly/decision-prompt.ts)）。
   这不是"少写了几个工具"，是两种架构：kagami 让模型自己决定动作序列，Holly 由宿主代码编排固定流程、模型只填空。

2. **进程模型：11 进程 vs 1 进程。** kagami 的 PM2 起 11 个进程（[`ecosystem.config.cjs:6,21,34,45,58,71,85,98,111,124,138`](../ecosystem.config.cjs)），
   服务间靠 **Zod 契约驱动的 typed HTTP client** 通信；Holly 的 PM2 只起 1 个（[`Holly/ecosystem.config.cjs:10`](../../Holly/ecosystem.config.cjs)），
   `main.ts` 一个文件 8762 行（占 Holly TS 源码的 **50.8%**）。

3. **规模差一个数量级。** kagami 源码 **59,556 行 / 592 个文件**（不含测试与生成代码），Holly **16,407 行 / 30 个文件**
   （已剔除死代码 `codex-provider.ts`）。测试差距更大：kagami **1,439 个用例 / 215 个测试文件 / 35,077 行**，
   Holly **124 个用例 / 20 个测试文件 / 2,526 行**。

4. **"记忆检索"两边都还没真做。** 这是最反直觉的一条。Holly 的 Qdrant 存的是**无向量的 point**
   ——[`Holly/qdrant-store.ts:62-64`](../../Holly/qdrant-store.ts) 明写「not for nearest-neighbour search」；
   迁到 SQLite 后是单表 `memory_records` + `payload_json` 大字段，检索方式是 `ORDER BY received_at DESC LIMIT ?`
   （[`Holly/sqlite-store.ts:260-266`](../../Holly/sqlite-store.ts)）。kagami 有完整的 embedding 基础设施
   （gemini / TEI 两个 provider + `embedding_cache` 表），但**没有任何消费方**——
   [`apps/agent/src/app/server-runtime.ts:109`](../apps/agent/src/app/server-runtime.ts) 注释直说「将来记忆系统接线时按需在 agent 侧新建 client」。
   两边都是「最近 N 条」，不是 RAG。

5. **同源但独立的能力：ai-tone。** 两边都移植了同一个上游 `Hei-AI/AIRadar`（TF-IDF 字符 n-gram + 逻辑回归的中文"AI 味"分类器），
   算法逐函数一致，但**模型快照不同、用途不同**：kagami 27,740 个 n-gram、intercept `-2.667593`、**达阈值即拦截不发**；
   Holly 27,360 个 n-gram、intercept `-2.753252`、**只打分记录不拦**。这是"同一上游、各自移植"，不是一边抄另一边。

---

## 总览对比表

| 维度 | kagami | Holly |
| --- | --- | --- |
| 包管理 / 形态 | pnpm workspace monorepo，12 apps + 21 packages | 单包 `pybot-ts`，根目录平铺 30 个 `.ts` |
| 源码规模（不含测试） | 59,556 行 / 592 文件 | 16,407 行 / 30 文件 |
| 最大单文件 | `apps/agent` 整个 app 34,130 行（307 文件） | `main.ts` 8,762 行（占 50.8%） |
| 进程数（PM2） | 11 | 1 |
| 进程间通信 | Zod 契约 + typed HTTP client + SSE | 无（同进程函数调用） |
| LLM provider | 4：`deepseek` / `openai` / `openai-codex` / `claude-code` | 2：`codex` / `claude` |
| 工具调用 | 有，66 个 `.tool.ts`，ReAct kernel | **无** |
| 模型输出形态 | tool_calls + 文本，流式 SSE 解析 | 单次 JSON（`jsonSchema` 结构化输出） |
| 凭据管理 | 自建 PKCE OAuth + DB 持久化 + 刷新 timer（`packages/auth`，24 文件） | 直读 `~/.codex/auth.json` / macOS Keychain（`security` CLI） |
| 持久化 | Prisma + SQLite，**20 个 model / 17 个迁移**，另 scheduler 独立库 | 单表 `memory_records`（`CREATE TABLE IF NOT EXISTS`，无迁移系统）+ 若干 JSON 文件 |
| IM 接入 | 独立进程 `apps/napcat`，WS↔SSE + outbox 重放 | `main.ts` 内直连 `ws://127.0.0.1:8082` |
| 定时调度 | 独立进程 `apps/scheduler`（croner，cron+interval，SSE 推 tick） | `setInterval(scheduleAutonomyTick, 60_000)` |
| 前端 | React 19 + Vite，13 个页面（`apps/web`，9,329 行） | `main.ts` 内联 HTML 字符串 + vendored Vue |
| 可观测性 | `apps/metric`（DuckDB）+ `apps/console` + 结构化 logger | `console.log` + 监控页 SSE |
| 测试 | vitest，1,439 用例 / 215 文件 | `node --test`，124 用例 / 20 文件 |
| lint / format / 死码 | eslint + prettier + knip | **无** |
| CI | GitHub Actions 5 路并行矩阵 | 无 `.github/` |
| 配置密钥分离 | `config.yaml` + gitignored `config.secret.yaml` | 本地 `config.yaml` / `.env` 被 Git 忽略，仅提交 `.example` 模板 |
| 对外绑定 | 仅 gateway 绑 `0.0.0.0:20004`，其余全绑 `127.0.0.1` | 全部绑 `127.0.0.1:5000` |

---

## 1. 整体架构与进程模型

### kagami：11 个 PM2 进程 + 契约化 RPC

[`ecosystem.config.cjs`](../ecosystem.config.cjs) 列出 11 个进程：`kagami-agent`(6)、`kagami-console`(21)、
`kagami-gateway`(34)、`kagami-oss`(45)、`kagami-metric`(58)、`kagami-browser`(71)、`kagami-llm`(85)、
`kagami-spire`(98)、`kagami-napcat`(111)、`kagami-pixel`(124)、`kagami-scheduler`(138)。

注意 `apps/web` **不在** PM2 里：它是构建期产物，由 gateway 在 build 时拷进自己的 `dist/public`
（[`apps/gateway/package.json:8`](../apps/gateway/package.json) 的 `build` 跑 `node scripts/copy-web-dist.mjs`）。

拆分的理由在注释里逐条写明，全部是**生命周期隔离**：

- `kagami-browser`（[`ecosystem.config.cjs:69`](../ecosystem.config.cjs)）「独立 PM2 生命周期，agent 重启不杀它（issue #173）」
- `kagami-spire`（:96）「agent 重启不打断进行中的对局」
- `kagami-napcat`（:109）「agent 重启不打断到 NapCat 的 WS 长连接（issue #347）」
- `kagami-pixel`（:122）「agent 重启不丢画布」
- `kagami-scheduler`（:135）「agent 重启不打断计时节奏（issue #428）」

`kagami-agent` 独有 `exp_backoff_restart_delay: 100`（[`ecosystem.config.cjs:15`](../ecosystem.config.cjs)），
注释解释是配合 `fatalExit` 的 fail-fast：主循环崩溃就非零退出让 PM2 拉起干净进程重放快照，指数退避防 crash-loop 打满 CPU。

**通信机制。** 核心是 [`packages/http/src/contract.ts`](../packages/http/src/contract.ts)：一条路由的
method / path / input schema / output schema 是**单一事实源**。生产者用 `registerJsonRoute` 接 Fastify handler，
消费者用 `createClient(contract)` 拿 typed client，两端从同一份 Zod schema 派生类型：

> 「改契约的 `output`，服务端 handler 与消费端调用点会**同时**编译报错。这解决了「HTTP 这一跳的类型空洞」
> （服务端 `z.unknown()` + 客户端 `as` 各写一遍）」——[`packages/http/src/contract.ts:8-11`](../packages/http/src/contract.ts)

实际共 **66 条 `defineJsonRoute`** + 2 条 `defineBinaryEnvelopeRoute` + 5 条 `defineBinaryRawRoute`，散在 9 个 `*-api` 包里。

二进制路由单独一套工厂（[`packages/rpc-client/src/binary-client.ts`](../packages/rpc-client/src/binary-client.ts)），
理由写得很清楚：「字节流不进 Zod（一 parse 就得整块缓冲，破坏流式 + OOM 防线）」；其中 `binary-raw` 形态
**只生成传输**，把裸 `Response` 交回调用方，「下行字节 / content-length 早拒 / 404→领域错误这类语义是领域逻辑，留在调用方」。

**网关分流** 是纯函数决策（[`apps/gateway/src/routing.ts:44-64`](../apps/gateway/src/routing.ts)）：
`/metric` → metric，`/auth` + `/llm/providers` → llm，`/app-log|/llm-chat-call|/inner-thought|/napcat-event|/napcat-group-message|/todo` → console，
`/oss-object` → oss，`/scheduler/tasks` → scheduler，其余兜底 agent。安全边界靠**前缀白名单**实现：
OSS 的写路由 `/objects`、llm 的 `/internal/*`、scheduler 的 register/status/SSE 都刻意不进前缀表，
「浏览器经网关够不到」。

### Holly：单进程

[`Holly/ecosystem.config.cjs`](../../Holly/ecosystem.config.cjs) 只有一个 app `holly`，
且直接跑 `main.ts`（`interpreter_args: "--env-file-if-exists=.env --import tsx"`，:13）——**运行时用 tsx 即时编译 TypeScript**，
不跑预编译产物。`kill_timeout: 8000`（:24）是为了给 `flushContextAndExit` 写 `conversation-context.json` 留时间。

进程内起两样东西：`createServer` 监听 `127.0.0.1:5000`（[`Holly/main.ts:412-413,8747`](../../Holly/main.ts)）和
一个 WS 客户端连 `ws://127.0.0.1:8082`（[`Holly/main.ts:419,6918`](../../Holly/main.ts)）。没有服务边界，
自然也没有 RPC——所有模块间是普通函数调用，`main.ts` 从 20 个本地模块 import。

**成本对照：** kagami 为服务边界付出的是 9 个 `*-api` 契约包（`agent-api` 66 行、`browser-api` 108 行、
`oss-api` 135 行、`pixel-api` 244 行、`spire-api` 220 行、`console-api` 348 行、`scheduler-api` 426 行、
`metric-api` 528 行、`llm-api` 584 行）+ `rpc-client` 842 行 + `http` 981 行 ≈ **4,500 行纯管道代码**，
在 Holly 里这部分开销为 0。

---

## 2. 模块边界与依赖组织

### kagami 的分层契约

依赖图（从各 `package.json` 实测，非文档转述）：

```
零依赖叶子:  @kagami/config (yaml)      @kagami/llm (无外部依赖)      @kagami/http (fastify+zod)
契约层:      @kagami/{agent,browser,console,llm,metric,napcat,oss,pixel,scheduler,spire}-api → 只依赖 @kagami/http + zod
内核:        @kagami/kernel → config + http + llm
消费端 SDK:  @kagami/rpc-client → http + kernel
             @kagami/{metric,scheduler}-client → kernel + rpc-client + 对应 -api
运行时:      @kagami/llm-client → kernel + llm + llm-api
             @kagami/agent-runtime → llm （仅此一个！）
             @kagami/persistence → http + kernel + llm
             @kagami/auth → http + kernel + llm + llm-api + persistence
```

四类角色的契约非常清晰：

- **`*-api`（9 个）= 生产者契约包。** 每个只依赖 `@kagami/http` + `zod`，是「某个进程对外暴露什么」的单一事实源。
  注释明确了归属规则：「agent 对上游（llm/oss/browser/spire/metric）的消费契约在各上游自己的 `*-api` 包，
  这里只收 agent 自己产出的路由」（[`packages/agent-api/src/contract.ts:8-10`](../packages/agent-api/src/contract.ts)）。
- **`*-client`（2 个）= 消费端 SDK。** 在 `createClient` 之上包领域行为。`metric-client` 是 fire-and-forget
  （永不抛、失败只记日志、2s 超时），`scheduler-client` 管注册 + SSE 派发 + 本地并发锁 + occurrence 去重。
- **`kernel` = 后端基础设施，但刻意不含数据库。** 内容是 config / logger / BizError / 卫星服务启动壳
  （[`packages/kernel/src/`](../packages/kernel/src/) 共 23 文件 2,043 行），**没有 Prisma、没有 better-sqlite3**——
  那些在 `persistence`。
- **`agent-runtime` = 与项目无关的通用 agent 内核。** 它的**唯一**依赖是 `@kagami/llm`
  （[`packages/agent-runtime/package.json`](../packages/agent-runtime/package.json)），30 文件 3,544 行，
  含 ReAct kernel / Tool / App / Effect / 队列 / 串行执行器。业务语义（QQ、IThome、像素画）全在 `apps/agent`。

一个刻意的约束值得记：`packages/http` 的 contract / wire / url 三个模块必须**类型层面浏览器安全**——
「连 `import type` 都不得引 fastify / node:*——d.ts 里的类型引用会把 @types/node 拖进 web 的类型空间
（全局 setTimeout 变型）」（[`packages/http/src/contract.ts:19-21`](../packages/http/src/contract.ts)）。
服务端注册原语因此单独放在 `register.ts`。同理，`rpc-client` 从 `http` 里拆出来，是为了把「重建 BizError」
对 kernel 的依赖隔离在消费端，让服务端的 `http` 保持零 kernel 依赖
（[`packages/rpc-client/src/client.ts:16-17`](../packages/rpc-client/src/client.ts)）。

`apps/agent/src` 内部只有四个目录：`acl/`（对 llm/browser/spire/oss/pixel/napcat 六个进程的防腐层客户端）、
`agent/`（业务：`apps/` 13 个 App + `capabilities/` 13 个能力 + `runtime/`）、`app/`（装配）、`ops/`（观测查询）。

### Holly 的组织

单层平铺，边界靠**文件**而非包。观察到的分层意图是真实的：

- `main.ts` 是编排层 + HTTP 服务 + WS 客户端 + 全部前端 HTML。
- 从 main.ts 里**抽出去**的模块有明确动机，注释都写了。典型是
  [`Holly/decision-prompt.ts:1-3`](../../Holly/decision-prompt.ts)：「Kept out of main.ts so tests/smokes can
  import the EXACT production prompt without triggering main.ts's bootstrap() on import」——
  **为了可测试性而抽模块**，因为 `main.ts` 一 import 就会启动 bootstrap。
  `holly-state.ts` / `context-store.ts` 同理（后者：「declared here so the store stays importable by tests
  without pulling in main.ts's bootstrap」，[`Holly/context-store.ts:11-12`](../../Holly/context-store.ts)）。
- 依赖是单向的：20 个模块被 `main.ts` import，模块之间只有少量横向依赖
  （`browser-agent.ts` → `web-search.ts` + `domain-reputation.ts`；`memory-store.ts` → `qdrant-store.ts` / `sqlite-store.ts`；
  `autonomy-engine.ts` → `proactive-engine.ts`）。

所以 Holly 不是"没有设计"，而是**设计的粒度停在文件级**：抽出去的是能独立测试的纯逻辑，留在 main.ts 的是有状态的编排。
代价是编排本身（8,762 行、259 个顶层函数）无法单元测试，Holly 的 20 个测试文件里**没有一个测 main.ts**。

---

## 3. LLM 调用层

### provider 抽象

kagami 的 provider 接口（[`packages/llm-client/src/provider.ts:22-27`](../packages/llm-client/src/provider.ts)）：

```ts
export interface LlmProvider {
  id: LlmProviderId;
  isAvailable?(): Promise<boolean>;
  chat(request: LlmChatRequest): Promise<LlmProviderChatResult>;
  close?(): void | Promise<void>;
}
```

4 个实现（[`packages/llm-client/src/providers/`](../packages/llm-client/src/providers/)）：
`deepseek-provider` / `openai-provider` / `openai-codex-provider` / `claude-code-provider`，
另有共享的 `openai-compatible-provider` 和 `mappers/openai-chat-mapper.ts`。
provider 标识枚举在最底层的零依赖包里单源维护：
`LLM_PROVIDER_IDS = ["deepseek","openai","openai-codex","claude-code"]`（[`packages/llm/src/index.ts:20`](../packages/llm/src/index.ts)），
注释说明「新增 / 删除 provider 只改这一处」，config schema / 后端装配 / auth 全从它派生。

Holly 没有 provider 接口。`LlmProvider = "codex" | "claude"`（[`Holly/llm-client.ts:17`](../../Holly/llm-client.ts））
是个字符串联合，两条路径在 `llm-client.ts` 内部用 if 分派，各自有独立的 `buildXxxRequest` / `extractXxxText` /
`readXxxCredentials` 函数（codex 在 :380-554，claude 在 :556-797）。新增 provider = 在这个 1,166 行文件里再加一组函数。

### 关键发现：`codex-provider.ts` 是死代码

调研任务把 `Holly/codex-provider.ts`（813 行 / 35KB）列为 Holly LLM 层的一部分。**它不参与构建，也不被任何东西引用：**

- 被 tsconfig 显式排除：`"exclude": ["codex-provider.ts"]`（[`Holly/tsconfig.json`](../../Holly/tsconfig.json)）
- `Holly/dist/` 里**没有** `codex-provider.js`（其余 30 个 `.ts` 都有对应产物）
- 它的 import 路径在 Holly 里根本不存在：`from "../llm-service.js"`、`from "../../type/llm.js"`
  （[`Holly/codex-provider.ts:6-9`](../../Holly/codex-provider.ts)）——Holly 是平铺布局，没有 `../` 也没有 `type/` 目录
- 全仓库对 `registerProvider` 的引用只有两处，都在它自己文件内（:6 import、:813 调用）

它是从**另一个有 provider 注册机制、有 `LLMTool`/`LLMToolCall` 类型的代码库**整文件拷进来的孤儿，
风格也不同（4 空格缩进，Holly 其余文件是 2 空格）。计算 Holly 规模时应剔除：Holly 实际源码是 16,407 行而非 17,220 行。

### profile 配置

Holly 的 profile 是**面向用户的模型档位**：`llm.active` 选一个，`llm.profiles.<name>` 给
`{provider, model, system_prompt?}`（[`Holly/config.yaml:103-115`](../../Holly/config.yaml)：
`codex_gpt54` / `claude_sonnet` / `claude_opus` / `claude_haiku`，当时 active = `claude_opus`）。
切换是运行时的——监控页 `POST /api/llm/active`（[`Holly/main.ts:8614`](../../Holly/main.ts)）能热切，
且会 `saveConfig` 写回 config.yaml（[`Holly/llm-client.ts:158`](../../Holly/llm-client.ts)）。

kagami 没有 "profile" 概念，改用 **usage（用途）→ provider/model** 的映射：
`server.llm.usages.agent` 等（[`config.yaml`](../config.yaml)），ReAct kernel 每次 chat 传 `options.usage`
（[`packages/agent-runtime/src/react-kernel.ts:35-37`](../packages/agent-runtime/src/react-kernel.ts)）。
即"哪个场景用哪个模型"是配置事实，而不是全局单档位。

### 流式

两边都做了流式，但目的不同。

kagami 的 claude-code provider 请求体固定 `stream: true`
（[`packages/llm-client/src/providers/claude-code-request.ts:33`](../packages/llm-client/src/providers/claude-code-request.ts)），
SSE 解析在 [`claude-code-response.ts:114-250`](../packages/llm-client/src/providers/claude-code-response.ts)，
按 `content_block_start/delta/stop` 重建 block 数组——**关键是要重建 `tool_use` block**：
`text_delta` 拼文本，`input_json_delta` 拼 `partialJson` 再 parse 成工具参数。流式在这里是工具调用协议的必需品。

Holly 的 `readCodexStreamText`（[`Holly/llm-client.ts:403-462`](../../Holly/llm-client.ts)）只从流里拼出**文本**，
因为终点是一个 JSON 字符串。Claude 路径根本不流式（`buildClaudeRequestBody` 无 stream 字段）。

### 重试

Holly：一个常量对（[`Holly/llm-client.ts:114-115`](../../Holly/llm-client.ts)）
`FETCH_FAILED_MAX_ATTEMPTS = 5` / `FETCH_FAILED_RETRY_DELAY_MS = 3_000`，判据是
`isFetchFailedError`（:141）——**按 error message 字符串匹配**，固定延迟，只覆盖网络层。

kagami 曾经也是字符串匹配，并且把改造过程写进了注释——这段是整个仓库里最能说明其工程取向的一处
（[`packages/llm-client/src/retryable-error.ts:3-13`](../packages/llm-client/src/retryable-error.ts)）：

> 「哪次 LLM 失败可以退避重试」以前靠调用方（agent 侧）逐字匹配两条中文 `BizError.message` 判定——
> 分类学的所有权（错误由本包抛出）和判定点分居两个包，靠一个魔法字符串跨 3 个包、HTTP 边界、约 19 个抛出点隐式绑定，
> 改文案 / 漏盖新 provider 就静默退化。现在把判据下沉为本包的结构化 `meta.retryable` 布尔位。

且判据落在 `meta` 而非 error 子类是被 wire 边界逼出来的：错误经 `toBizErrorWire → bizErrorFromWire`
跨进程往返时只重建基类，`instanceof 子类` 过不去，但 `meta` 会被忠实携带（:11-13）。
**这是拆进程带来的真实约束，Holly 单进程不会遇到。**

### 工具调用

kagami 的完整链路：
`Tool`（name/description/parameters JSON Schema，[`packages/llm/src/index.ts:96-100`](../packages/llm/src/index.ts)）
→ `ToolComponent`（加 `execute` + `effects`，[`packages/agent-runtime/src/tool/tool-component.ts:27-37`](../packages/agent-runtime/src/tool/tool-component.ts)）
→ `ReActKernel.runRound`（[`packages/agent-runtime/src/react-kernel.ts:46-52`](../packages/agent-runtime/src/react-kernel.ts)）
→ 66 个 `.tool.ts`。

`ToolExecutionResult` 有个双通道设计：`content` 是给 LLM 看的 tool_result 字符串（ReAct 协议要求每个 tool_call 都跟一个 tool_result），
`effects` 是结构化副作用由 Agent 的 `EffectInterpreter` 解释。kernel 把两者分开返回
（`appendedMessages` vs `effectMessages`，[`react-kernel.ts:60-67`](../packages/agent-runtime/src/react-kernel.ts)），
注释说明这是「#78 把 effect 下沉进 kernel 后，commit 方持久化这些消息的唯一来源——丢了它，App 的"屏幕"内容就进不了 ledger」。

Holly 侧对应的"能力调用"全是**宿主代码硬编排**：模型返回 `need_search=true` → 宿主调 `searchWeb()` →
把 `[联网搜索结果]` 块塞回 prompt → 再问一次（[`Holly/decision-prompt.ts:36,38`](../../Holly/decision-prompt.ts)）。
一次固定的两跳，模型无法自己决定调几次、调什么。

---

## 4. 持久化与记忆

### kagami：Prisma + 20 个 model + 迁移系统

[`packages/persistence/prisma/schema.prisma`](../packages/persistence/prisma/schema.prisma) 共 **20 个 model**，
`datasource db { provider = "sqlite" }`，走 `@prisma/adapter-better-sqlite3`：

| 领域 | model |
| --- | --- |
| LLM | `LlmChatCall`（含 `nativeRequestPayload`/`nativeResponsePayload`/`nativeError` 三份原始负载）、`EmbeddingCache`、`ClaudeFileCache` |
| 日志 | `AppLog`（traceId + level + metadata JSON） |
| NapCat | `NapcatEvent`、`NapcatQqMessage`、`NapcatEventOutbox` |
| OAuth | `OauthSession`、`OauthState` |
| Agent 上下文 | `RootAgentRuntimeSnapshot`、`LinearMessageLedger`、`InnerThought` |
| App 状态 | `AppState`（appId → 不透明 JSON）、`TodoItem`、`TerminalState`、`TerminalOutput`、`ImageAsset`、`BrowserCredential` |
| IThome | `IthomeArticle`、`IthomeFeedCursor` |

`packages/persistence/prisma/migrations/` 有 **17 个迁移**，且**包含删除性迁移**——
`drop_root_agent_session_snapshot`、`drop_story_tables`、`drop_metric_chart`、`drop_metric_table`、
`drop_auth_usage_snapshot`、`drop_image_asset_mime`、`collapse_news_into_ithome`。这说明 schema 经历过真实重构，
不是只增不减。

`apps/scheduler` 有**第二个独立 Prisma 库**（[`apps/scheduler/prisma/schema.prisma`](../apps/scheduler/prisma/schema.prisma)），
只有一个 `TaskRun` model，且**刻意反范式化**：「ownerId / taskName 是裸字符串，不是外键——scheduler 库里没有 tasks 表，
任务定义仍由使用方（agent）在代码里写死」（:13-15）。

迁移复用同一个脚本，靠两个环境变量参数化
（[`scripts/prisma.sh:7-10`](../scripts/prisma.sh)）：`PRISMA_PACKAGE_DIR` + `PRISMA_CONFIG_KEY`。
脚本还有两个细节：`generate` 用占位 `DATABASE_URL` 跳过 config.yaml，「让 build / typecheck 与运行时配置解耦」（:22-24）；
`migrate dev` 自动追加 `--create-only`（:44-52），即**迁移文件必须人工过目后才 apply**。

`apps/oss` 是唯一绕开 Prisma 的：裸 better-sqlite3 + 分片 blob 文件
（[`apps/oss/src/store/object-store.ts`](../apps/oss/src/store/object-store.ts)）。

### Holly：Qdrant → SQLite 的迁移痕迹

迁移是**真的、完整的、且刻意保留双后端**：

- 抽象层：[`Holly/memory-store-types.ts`](../../Holly/memory-store-types.ts) 定义 `IncomingMessageStore` 接口
  （`saveMessage` / `saveInternalMemory` / `saveWorldObservation` / `listRecentMemories`）
- 分派层：[`Holly/memory-store.ts:58-81`](../../Holly/memory-store.ts) 按 `database.provider` 选后端，
  且有向后兼容分支：「Backward compatibility for existing installations that only have the historical `qdrant` section」（:43-45）
- 两个实现：`qdrant-store.ts`（571 行）、`sqlite-store.ts`（274 行）
- 一次性迁移脚本：`migrate-qdrant-to-sqlite.ts`（36 行），
  [`LOCAL_DATABASE.md`](../../Holly/LOCAL_DATABASE.md) 说明「Qdrant point ID 会作为 SQLite 主键保留，因此命令可重复运行」——幂等
- 当前生效的是 SQLite：`database.provider: sqlite`（[`Holly/config.yaml:127-131`](../../Holly/config.yaml)）

**数据模型差异是最大的一条。** Holly 的 SQLite 是单表 + JSON 大字段
（[`Holly/sqlite-store.ts:83-101`](../../Holly/sqlite-store.ts)）：

```sql
CREATE TABLE IF NOT EXISTS memory_records (
  id TEXT PRIMARY KEY, received_at TEXT NOT NULL, message_type TEXT,
  group_id TEXT, user_id TEXT, payload_json TEXT NOT NULL,
  inserted_at TEXT NOT NULL DEFAULT (...)
) STRICT;
```

`message_type` 是软类型标签，三种写入路径（`upstream_ws` / `holly_internal` / `holly_world_observation`）
共用这张表，只靠 payload 里的 `source` 和 `schema_version: 2` 区分（:187-241）。
没有迁移系统——`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` 就是全部 schema 管理。
好处是加字段零成本（塞进 payload_json），代价是无法用 SQL 表达任何跨记录约束，且查询只能用那 4 个提升出来的列。

Holly 还有一层 kagami 没有的东西：**磁盘持久化 outbox**（[`Holly/qdrant-outbox.ts:38-40`](../../Holly/qdrant-outbox.ts)）——
「Each item is a separate atomically renamed file, so a process crash cannot truncate the rest of the queue」。
这是为了对抗 Qdrant Cloud 的网络不可靠。kagami 有概念上对应的 `NapcatEventOutbox`，但落在 SQLite 表里
（[`schema.prisma:92-99`](../packages/persistence/prisma/schema.prisma)：「napcat 先事务落这里拿 seq 再推 SSE，
agent 重连带 Last-Event-ID 回放 seq> 缺口、按 seq 去重（严格 at-least-once）」）。

其余状态 Holly 走 JSON 文件 + 原子写（temp + rename）：
`holly-state.ts`（[:9-11](../../Holly/holly-state.ts)「持久化:原子写(temp + rename),损坏 JSON → 默认值不崩」）、
`context-store.ts`、`domain-reputation.ts`。kagami 对应的是 `AppState` 表 + `RootAgentRuntimeSnapshot` + `LinearMessageLedger`。

### 「记忆检索」两边都不存在

这一点值得单独强调，因为两边的文档都容易让人误会。

**Holly 的 Qdrant 不做向量检索。** [`Holly/qdrant-store.ts:54,62-64`](../../Holly/qdrant-store.ts)：

> `vector: Record<string, never>;`
> // not for nearest-neighbour search. Qdrant accepts points with no vectors; the
> // empty vector map avoids allocating a meaningless `[0]` dense vector per row
> // while keeping the existing collection compatible with future real vectors.

检索用的是 `client.scroll(...)`（:275,548）而非 `search`。即 Qdrant 被当成一个带过滤的文档库用。
迁到 SQLite 后同理：`listRecentMemories` 是 `WHERE group_id/user_id/message_type = ? ORDER BY received_at DESC LIMIT ?`
（[`Holly/sqlite-store.ts:243-272`](../../Holly/sqlite-store.ts)）。

**kagami 的 embedding 基础设施没有消费方。** `packages/llm-client/src/embedding/` 有完整的
provider 抽象 + gemini / TEI 两个实现 + `EmbeddingCache` 表 + `POST /internal/embed` 路由，
但全仓库唯一的 `.embed(` 调用点是 [`apps/llm/src/http/internal-llm.handler.ts:57`](../apps/llm/src/http/internal-llm.handler.ts)
——也就是 HTTP handler 自己。`apps/agent` 里对 embedding 的引用只有两处：
`retention-tasks.ts` 里的 `embedding_cache` 清理策略，和
[`apps/agent/src/app/server-runtime.ts:109`](../apps/agent/src/app/server-runtime.ts) 这句注释：

> 「embedding 能力也在服务侧（**将来记忆系统接线时**按需在 agent 侧新建 client）」

README 对此是诚实的：「Her long-term memory is currently being redesigned. For now she keeps a raw ledger of
what has been said, and remembers within a conversation.」（[`README.md`](../README.md)）

---

## 5. 消息接入 / IM 网关

### Holly：main.ts 内直连

WS 客户端在 `main.ts` 里，用 `ws` 包（[`Holly/main.ts:8`](../../Holly/main.ts)）。
目标 `ws://127.0.0.1:8082`（:419 fallback，实际读 `config.yaml` 的 `napcat.ws_url`，[`Holly/config.yaml:118-120`](../../Holly/config.yaml)）。
生命周期函数散在 main.ts：`connectWebSocketClient`(6882) / `disconnectWebSocketClient`(6866) /
`scheduleWebSocketReconnect`(6854) / `rejectAllPendingWsActions`(7147)。
`WS_RECONNECT_DELAY_MS = 8000`、`WS_ACTION_TIMEOUT_MS = 10_000`（:434,439）。

一个 Holly 独有的设计：**QQ 运行模式是模型决定的**。`QqRuntimeMode = "offline" | "observe" | "active"`
（[`Holly/holly-bootstrap.ts:1`](../../Holly/holly-bootstrap.ts)），启动时让模型自己决定今天上不上线
（`qq_mode: active`、`fallback_qq_mode: observe`、`reconsider_minutes: 60`，[`Holly/config.yaml:5-9`](../../Holly/config.yaml)），
`offline` 时主动断开 WS（[`Holly/main.ts:6247`](../../Holly/main.ts) `disconnectWebSocketClient("Holly chose QQ offline mode.")`）。
kagami 没有对应概念。

### kagami：独立 napcat 进程 + WS↔SSE 桥

[`apps/napcat`](../apps/napcat/)（40 文件 10,700 行）持有到 NapCat 的 WS 长连接
（[`apps/napcat/src/application/napcat-gateway/transport.ts:27`](../apps/napcat/src/application/napcat-gateway/transport.ts) `NapcatGatewayTransport`），
对 agent 暴露两个方向：

- **出站**：agent 经 `HttpNapcatClient`（[`apps/agent/src/acl/napcat-client.ts`](../apps/agent/src/acl/napcat-client.ts)）
  走 `@kagami/napcat-api` 契约发消息。
- **入站**：SSE `GET /napcat/events`（[`apps/napcat/src/http/napcat-events.handler.ts:42`](../apps/napcat/src/http/napcat-events.handler.ts)），
  agent 拨出订阅。

入站的可靠性设计是这个拆分最实质的产物，注释把顺序保证写死了（:27-31）：

> 交接顺序保证无丢/无乱序/无重：先 `broadcaster.add`（此刻起实时事件先进订阅者缓冲）→ 回放
> outbox(lastEventId, now] → flush 缓冲（按 seq 去重 replay 已发过的）→ 转实时。

配套还有 SSE 背压处理：`SSE_BACKPRESSURE_GRACE_MS = 15_000`，「res.write 背压后等 drain 这么久，
还不 drain 就销毁连接（消费方视为真死/半开）」（:19），以及 `X-Accel-Buffering: no` 防反代缓冲（:52-53）。

napcat 进程还兼管 **vision**（[`apps/napcat/src/vision/application/vision-agent.ts`](../apps/napcat/src/vision/application/vision-agent.ts)）
和图片资产登记（`ImageAsset` 表：NapCat file_id → OSS resid + vision 描述，「每张不同的图全局只下载/描述/PUT 一次」，
[`schema.prisma:262-265`](../packages/persistence/prisma/schema.prisma)）。Holly 无图片理解能力。

---

## 6. 自主性 / 主动行为

这是两边**设计意图最接近、实现路径最不同**的一块。

### Holly：一分钟一次的 tick + 显式状态机

调度是最朴素的：`setInterval(scheduleAutonomyTick, PROACTIVE_TICK_INTERVAL_MS)`
（[`Holly/main.ts:8524`](../../Holly/main.ts)），`PROACTIVE_TICK_INTERVAL_MS = 60 * 1000`（:495）。
同一个 bootstrap 里还有三个 interval：`flushUnreadMessagesToModel`(60s, :8486)、
`scheduleContextWarm`(20min, :8489)、`persistConversationContext`(60min, :8492)。

每次 tick 跑 `runAutonomyLoop`（[`Holly/autonomy-engine.ts:259`](../../Holly/autonomy-engine.ts)），
它按顺序检查 4 项（[`autonomy-engine.ts:13-17`](../../Holly/autonomy-engine.ts)）：
`world_observation` / `memory_reflection` / `archive_writing` / `group_proactive`，
每项产出 `status: "disabled"|"waiting"|"acted"|"no_action"|"deferred"` + `reason` + `nextEligibleAt`。
这个 trace 是**给运维看的**，注释说得很明确（:26-28）：

> A concise, operator-facing trace of what the once-per-minute scheduler checked. This is policy/runtime state,
> not a model provider's hidden chain of thought. `nextEligibleAt` lets the monitor explain why an interval gate held.

主动发言的节流是一套完整的状态机，写在 [`Holly/holly-state.ts:3-11`](../../Holly/holly-state.ts) 的文件头注释里：

```
每个 tick:
  rollDaily()                      // 跨天重置 dailyCount / globalDailyCount
  settle pendingObservation        // 观察窗到点 → 成功(退避恢复)或被无视(backoff++)
  gate(...) 通过 → 记一次主动 + 开新 pendingObservation
```

即 **Holly 会观察自己主动发言之后有没有人理**，没人理就指数退避（`backoffLevel`，有效阈值 ×`multiplier^level`），
且 engaged 状态有 TTL 防永久压制（:53-55 「带 TTL,过期后同主题可重新触发(codex:别永久压制)」）。
配置在 [`Holly/config.yaml:166-182`](../../Holly/config.yaml)：`per_group_daily_cap: 6` / `global_daily_cap: 20` /
`cooldown_minutes: 30` / `backoff_multiplier: 1.5` / `observation_window_minutes: 15`，且当前 `mode: shadow`（只记不发）。

### kagami：外部 scheduler 进程 + 模型自主的 inner-voice

kagami 把定时**能力**和自主**行为**分开了。

**定时能力**是独立进程 [`apps/scheduler`](../apps/scheduler/)，且刻意做成「不认识业务的薄时钟」：
使用方经 `SchedulerClient` 注册 `{name, schedule, misfire}`，到点经 SSE 推 tick 回去
（[`packages/scheduler-api/src/contract.ts:6-9`](../packages/scheduler-api/src/contract.ts)）。
支持 `interval` 和 `cron`（croner）两种 schedule，实际注册的任务只有三类，全在 agent 侧：
`todo` 提醒 tick + 每日 digest cron（[`apps/agent/src/agent/capabilities/todo/application/todo-scheduled-tasks.ts:21,30`](../apps/agent/src/agent/capabilities/todo/application/todo-scheduled-tasks.ts)）、
`data-retention` cron、`ithome` 轮询 interval，另有 kagami-llm 的 Claude Files 缓存每日 GC。

注册协议有几处值得记的设计（[`packages/scheduler-api/src/contract.ts:30-37`](../packages/scheduler-api/src/contract.ts)）：
`generation`（进程启动时刻毫秒时间戳，天然单调，调度器只保留最大值）用来处理进程重启换代；
`callbackBaseUrl` 让前端手动触发能**反向 POST 回 owner** 本地跑 handler；
stale 注册用 in-band `accepted:false`（判别联合）而非 409，「契约原生、免自定义 error-handler」（:53-55）。

**自主行为**走的是完全不同的路子：`inner-voice`
（[`apps/agent/src/agent/capabilities/inner-voice/`](../apps/agent/src/agent/capabilities/inner-voice/)）——
`idle-detector.ts` / `idle-tracker.ts` / `ledger-idle-signals.ts` 检测空闲，触发一个 task-agent 让模型
自己"憋念头"，产出经 `emit-inner-thought.tool.ts` 落 `InnerThought` 表。
schema 注释描述了三态覆盖（[`schema.prisma:291-293`](../packages/persistence/prisma/schema.prisma)）：
「一行 = 一次摸鱼触发。outcome 三态覆盖「所有触发」——injected（产出并注入上下文）/ empty（触发但没憋出念头）/
failed（Operation 抛异常）」。

**核心差异：** Holly 的自主性是**代码写死的 4 个检查项 + 显式退避状态机**，模型只负责填内容；
kagami 的自主性是**模型在 ReAct 循环里自己决定做什么**，代码只负责"叫醒她"（NotificationCenter + inner-voice 空闲触发）。
Holly 的方式可观测、可调参、可测试（`autonomy-engine.test.ts` / `proactive-engine.test.ts` / `holly-state.test.ts` 都存在）；
kagami 的方式上限更高但行为更难预测。

---

## 7. 配置系统

### kagami：两文件深合并 + Zod 校验 + 零依赖定位包

`@kagami/config`（[`packages/config/src/source.ts`](../packages/config/src/source.ts)，2 文件 391 行）是零依赖叶子包，
职责是**定位 + 合并**，「本模块领域无关，不认识任何具体配置字段」（:91-92）。

定位逻辑（`resolveConfigPath`，:55-82）比想象中讲究，三步 fallback：
cwd 逐级向上 → `anchorUrl`（调用方的 `import.meta.url`）所在目录逐级向上 → git worktree 主根回退。
注释解释是 depth-agnostic：「不依赖调用方在 dist 里的层级」。worktree 那步专门有个
`findGitWorktreeMainRoot`（:20-34）读 `.git` 文件里的 `gitdir:` 再读 `commondir`。

合并规则：`config.yaml`（版本控制）+ `config.secret.yaml`（gitignored）深合并，同名键 secret 优先、数组整体替换。
`config.secret.yaml.example`（[`config.secret.yaml.example:1-6`](../config.secret.yaml.example)）说明
「可覆盖任意字段（**不再有隐私路径白名单**）；约定上只往这里放凭据 / PII，拓扑（services.* / server.databaseUrl 等）
仍应留在 config.yaml」——即从"机制强制"退化成"约定"，是个刻意的简化。
原型污染由深合并的 `DANGEROUS_KEYS` 兜底（见 [`docs/configuration.md`](./configuration.md)）。

合并结果交 [`packages/kernel/src/config/config.loader.ts`](../packages/kernel/src/config/config.loader.ts) 的 `ConfigSchema` 做 Zod 校验。
`docs/configuration.md` 记了一条硬约束：「改配置 schema 必须同步 `config.loader.ts`、`config.yaml`、
`config.secret.yaml.example` 三处」。

`config.yaml` 里最有价值的是 `services:` 块（[`config.yaml:9-25`](../config.yaml)），是**单机进程拓扑的唯一事实源**，
11 个服务各自的 host/port。注释区分了两个概念：「host 是「别的服务/网关如何 reach 它」（reachable host），
不是绑定地址。绑定地址是各服务代码里的安全决策」。

### Holly：本地配置与公开模板分离

运行时读取本地 `config.yaml`，管理员 QQ、bot QQ、群号、服务地址、凭据和自定义人设均放在这个文件或 `.env` 中。
这两个文件被 Git 忽略；仓库只保留 [`config.example.yaml`](../config.example.yaml) 和 [`.env.example`](../.env.example)。
首次运行复制模板后填写真实值，已有安装继续使用原来的本地文件。示例默认只读、QQ 离线、管理员与自主任务关闭。
历史版本曾提交过私人配置；历史已完成脱敏重写，GitHub 也已确认清理旧对象。

加载方式是每个模块**各自读一遍**：`sqlite-store.ts` 有自己的 `resolveSqliteConfig`（:41-66）、
`memory-store.ts` 有 `resolveDatabaseProvider`（:32-56）、`llm-client.ts` 有 `loadConfig`（:149）。
四五处重复的 `YAML.parse(await readFile(configPath, "utf8"))`。没有 schema 校验，
各处手写 `if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw`（[`Holly/sqlite-store.ts:50-52`](../../Holly/sqlite-store.ts)）。

有一个 kagami 没有的能力：**配置可被运行时写回**。`saveConfig`（[`Holly/llm-client.ts:158`](../../Holly/llm-client.ts)）
让监控页切换 LLM profile 时持久化到 config.yaml。kagami 的 config 是只读的。

凭据来源也不同。Holly **直读本机现成凭据**：
`~/.codex/auth.json`（:110-111）、`~/.claude/.credentials.json`（:118）、
以及 macOS Keychain——`execSync('security find-generic-password -s "Codex Auth" -a ... -w')`（:266-267,594-595）。
kagami 自己跑完整 OAuth：见下节。

---

## 8. 可观测性与运维

### kagami：三个专门进程 + 结构化日志

- **`apps/console`**（39 文件 1,776 行）：管理台后端，**纯 DB 查询**，6 个领域各一套
  service + handler + mapper（app-log / llm-chat-call / inner-thought / napcat-event / napcat-group-message / todo）。
- **`apps/metric`**（28 文件 2,920 行）：指标进程，存储用 **DuckDB**
  （[`apps/metric/src/metric/infra/impl/duckdb-metric.impl.dao.ts`](../apps/metric/src/metric/infra/impl/duckdb-metric.impl.dao.ts)，
  `@duckdb/node-api`），四条路由 record / query / points / derive。
  上报侧是 fire-and-forget SDK `@kagami/metric-client`（「永不抛、失败只记日志、2s 超时」）。
- **`apps/web`**（89 文件 9,329 行）：React 19 + Vite + Tailwind + TanStack Query + Recharts，
  13 个页面（[`apps/web/src/pages/`](../apps/web/src/pages/)）：dashboard / control-panel / app-log-history /
  llm-history / inner-thought / main-agent-context / napcat-event-history / napcat-group-message-history /
  oss-objects / scheduler-tasks / todos / auth。

日志是结构化的：`AppLogger` + 双 sink（[`packages/kernel/src/logger/sinks/`](../packages/kernel/src/logger/sinks/)：
stdout + db），落 `AppLog` 表（traceId / level / message / metadata JSON）。

`llm_chat_call` 表把**三份原始负载**都存了（`nativeRequestPayload` / `nativeResponsePayload` / `nativeError`），
配套 `provider.ts` 里有个 `attachLlmProviderFailureContext` 用 Symbol 把失败上下文挂在 Error 上
（[`packages/llm-client/src/provider.ts:16,29-40`](../packages/llm-client/src/provider.ts)），
序列化时递归展开 Error 的 `cause` / `errors`（:97-100，注释举例「undici 的 `fetch failed` 把 ECONNREFUSED 放在 cause 里」）。

### Holly：内联监控页

监控 UI 是 `main.ts` 里的 HTML 字符串 + vendored Vue（[`Holly/main.ts:8538`](../../Holly/main.ts) 服务
`/vendor/vue.global.prod.js`）。三个页面共用一份 HTML（:8547）：`/` `/ws` `/thoughts` `/memories`。

API 端点 13 个（[`Holly/main.ts:8552-8733`](../../Holly/main.ts)）：
`/api/ws/events`（SSE）、`/api/thoughts`、`/api/memories`、`/api/llm/profiles`、`/api/llm/active`(POST)、
`/api/ws/reconnect`(POST)、`/api/usage/refresh`(POST)、`/api/usage/history`、`/api/mode`(GET/POST)、
`/api/archive`、`/archive/:file`、`/api/conversations`、`/api/conversations/:id`。

值得注意的是 Holly 的监控页有**控制面**（切模型、重连 WS、切 QQ 模式），kagami 的 `control-panel` 页面也有，
但 Holly 的控制面直接写回 config.yaml。

日志是 `console.log`（:6931,7009,7157,8748-8750），靠 PM2 的 `out_file`/`error_file` 落盘
（[`Holly/ecosystem.config.cjs:25-28`](../../Holly/ecosystem.config.cjs)）。

**归档产物：** Holly 有 `archive/` 目录 105 个文件（104 个 `.html` + 1 个 `.jsonl`），
是 `archive_writing` 自主任务的产出——模型定期自己写文章/诗，命名 `20260720-103511-poem.html`。
kagami 无对应能力。

---

## 9. 工程规范与质量基建

| | kagami | Holly |
| --- | --- | --- |
| 测试框架 | vitest 3 | `node --test` + tsx |
| 测试文件 | 215 | 20 |
| 测试用例（`it(`/`test(`） | **1,439** | **124** |
| 测试代码行 | 35,077 | 2,526 |
| 测试/源码比 | 0.59 | 0.15 |
| lint | eslint 9 + typescript-eslint（[`eslint.config.mjs`](../eslint.config.mjs) 3,767 字节） | 无 |
| format | prettier（[`.prettierrc.json`](../.prettierrc.json)） | 无 |
| 死码检测 | knip（[`knip.json`](../knip.json)，`files`/`dependencies`/`unlisted` 等 7 项设为 `error`） | 无 |
| typecheck | `pnpm -r typecheck`（每包 `tsc --noEmit`） | `tsc`（build 即 typecheck） |
| CI | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | 无 `.github/` |

kagami 测试分布（前五）：`apps/agent` 104 文件、`apps/napcat` 16、`apps/console` 12、
`packages/llm-client` 10、`apps/web` 10。

CI 是 5 路并行：`[typecheck, lint, test, knip]` 矩阵各发一台 4 核 runner，加一台轻量 runner 跑 format。
拆机的理由写在注释里，是实测出来的：

> 关键是「独立 runner」——vitest 自身就 maxWorkers=4 吃满整机，若与 typecheck / lint 挤在同一 runner
> 会互相抢核 thrash（**实测同机并行只从 125s 压到 113s**）。分机后各检查独占 4 核……用冗余计算换零耦合拓扑与达标墙钟。
> ——[`.github/workflows/ci.yml:12-18`](../.github/workflows/ci.yml)

且 CI 要求 build / typecheck / lint / test **全部 config-free**：「prisma generate 用占位 DATABASE_URL，
测试不读运行时 config」（:47-49）。

Holly 的测试是**纯逻辑模块的单测**，20 个文件一一对应 20 个抽出去的模块，
外加 1 个 integration（`test/integration/admin-code-worker.chain.test.ts`）。
`main.ts` 零覆盖——这是"为可测试性抽模块"策略的天花板：抽得出去的都测了，抽不出去的（8,762 行编排）测不了。
package.json 里 `test` 和 `test:integration` 是分开的两个脚本
（[`Holly/package.json:11-12`](../../Holly/package.json)），最新 commit 之一就是
「Keep the chain tests out of the per-job test gate」。

Holly 有 kagami 没有的一类东西：**eval 脚本**——
`proactive-eval.ts`（216 行，`npm run eval:proactive`）、`search-flow-eval.ts`（160 行）、
`ai-tone.ts` 自带 CLI（[`Holly/ai-tone.ts:101-127`](../../Holly/ai-tone.ts)，带偏置测试样本）。
这些是**真的打 LLM / 真的搜索**的冒烟评测，不是单测。kagami 全部是离线单测，无 eval 层。

---

## 10. 各自独有的能力

### 只在 Holly 有

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| **管理员自主改代码** | [`admin-code-worker.ts`](../../Holly/admin-code-worker.ts)(475) + [`admin-policy.ts`](../../Holly/admin-policy.ts)(316) | 管理员私聊 `/改进代码 <要求>` → 起隔离 job 调 codex CLI 改代码。有 job 状态机（`queued/running/applied/proposed/failed`）、**受保护路径白名单**（`PROTECTED_PATHS`，:44-54，含 `admin-policy.ts` / `admin-code-worker.ts` 自身与其测试，防自我解除限制）、子进程环境变量白名单（:63-75）、`MAX_PATCH_CHARS = 2_000_000`。配置在 [`config.yaml:17-27`](../../Holly/config.yaml) |
| **QQ 运行模式自决** | [`holly-bootstrap.ts`](../../Holly/holly-bootstrap.ts)(269) | 启动时模型自己决定 `offline/observe/active`，`reconsider_minutes` 后重新考虑 |
| **域名信誉** | [`domain-reputation.ts`](../../Holly/domain-reputation.ts)(155) | Beta(1,1) 先验的 per-domain 抓取成功率，动态给搜索结果排序；注释说是「a dynamic, data-driven complement to browser-agent.ts's static blocklist」 |
| **世界观察去重** | [`world-observation-dedup.ts`](../../Holly/world-observation-dedup.ts)(154) | URL 归一化（去 hash、去 `utm_*`/`spm`/`ref` 追踪参数、sort query、去尾斜杠）+ 语义标题去重，窗口 168 小时 |
| **显式搜索意图识别** | [`search-intent.ts`](../../Holly/search-intent.ts)(188) | 7 条中英文正则区分「搜一下」（命令）与「搜索算法怎么实现」（名词用法），支持省略式（"你搜索一下"→ 从上文推 query） |
| **自主写作归档** | `autonomy-engine.ts` 的 `write_archive` + `archive/` 105 文件 | 定期自己写 article / poem 存 HTML |
| **prompt cache 预热** | [`llm-client.ts:62-66`](../../Holly/llm-client.ts) `warmContext` | 用 `max_tokens=1` 重发上下文纯粹为刷新 Anthropic prompt cache，20 分钟一次 |
| **上下文压缩阈值** | [`config.yaml:30-32`](../../Holly/config.yaml) | `context_limit_tokens: 850000`（有个 commit 专门说「lower context budget to 850k to curb decision-loop degeneration」） |

### 只在 kagami 有

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| **完整 OAuth 凭据中心** | [`packages/auth`](../packages/auth/)（32 文件 4,591 行） | 自建 PKCE 流程（`shared/pkce.ts`）、callback server、刷新 scheduler、secret store，双 provider（codex / claude-code），落 `OauthSession` + `OauthState` 表 |
| **浏览器进程** | [`apps/browser`](../apps/browser/)(1,046) + 8 个工具 | playwright-core + CloakBrowser，工具有 navigate/click/type/press/eval/observe/screenshot/wait-for；凭据注入「明文密码经 BrowserService 直接 fill 进输入框，永不进 tool result / 语义树 / 截图 / 上下文」（[`schema.prisma:275-279`](../packages/persistence/prisma/schema.prisma)） |
| **对象存储** | [`apps/oss`](../apps/oss/)(1,423) | 自建 OSS，裸 better-sqlite3 + 分片 blob，binary 契约保流式 |
| **卡牌游戏引擎** | [`apps/spire`](../apps/spire/)(831) | 杀戮尖塔式 roguelike（`@kisinwen/sts-engine`），7 个工具，JSON 存档 |
| **像素画** | [`apps/pixel`](../apps/pixel/)(1,159) | 画布算子 + pngjs 出 PNG，9 个绘图工具，DB16 调色板 |
| **终端** | [`capabilities/terminal`](../apps/agent/src/agent/capabilities/terminal/) | `bash.tool.ts` + `read-bash-output.tool.ts`，`TerminalState`(cwd) + `TerminalOutput` 落库 |
| **高德地图** | [`apps/amap`](../apps/agent/src/agent/apps/amap/) | 8 个工具：geocode / regeocode / 路径规划 / 公交 / POI / 周边 / 天气 / 静态地图 |
| **Hacker News + IT之家** | `apps/hn`(4 工具) + `apps/ithome` | RSS 轮询 + 正文抓取，`IthomeArticle` + `IthomeFeedCursor` |
| **待办** | `apps/todo`(6 工具) + `TodoItem` 表 | 支持 `remindAt` / `repeatEveryMs` / `snoozedUntil` |
| **生图** | `capabilities/atelier` + `image/providers/openai-codex-image-provider.ts` | 走 codex OAuth 用 ChatGPT 订阅额度，无需 platform API key |
| **视觉理解** | [`apps/napcat/src/vision/`](../apps/napcat/src/vision/) | 图片 → 描述，配 `ImageAsset` 内容寻址缓存 |
| **数据保留** | `capabilities/data-retention` | cron 清理各表 |

### 两边都有但实现不同

| 能力 | kagami | Holly |
| --- | --- | --- |
| ai-tone | 27,740 n-gram / intercept `-2.667593` / **拦截**（`blockThreshold: 0.6`，达阈值不发等 `confirm_last` 二次确认） | 27,360 n-gram / intercept `-2.753252` / **仅打分**（[`ai-tone.ts:5-7`](../../Holly/ai-tone.ts)「SHADOW signal…score + log, never block」，因为「technical Chinese tends to score high, and Holly's interests are technical」） |
| 网页浏览 | playwright-core + CloakBrowser（独立进程，8 个 LLM 工具） | 裸 CDP over WebSocket（[`browser-agent.ts:1,242`](../../Holly/browser-agent.ts) `spawn` chromium + `new WebSocket(cdpUrl)`），无 LLM 工具，宿主固定流程调用 |
| 网页搜索 | 无独立搜索（靠 browser 工具） | SearXNG 自建实例（[`web-search.ts:3-11`](../../Holly/web-search.ts)，默认 `http://127.0.0.1:8888`，对应 `/path/to/searxng`） |
| 创造者概念 | `server.bot.creator.{name,qq}` 进 system prompt（[`agent-runtime.factory.ts:208-209`](../apps/agent/src/app/agent-runtime.factory.ts)），无特权动作 | `admin.user_ids` 白名单 + 强制回复 + 代码改进特权（[`admin-policy.ts:14-21`](../../Holly/admin-policy.ts)） |

---

## 文档与代码不一致的地方

### kagami

**1. ARCHITECTURE.md 的「后端模块 DAG」已完全过时。**
[`ARCHITECTURE.md:61-90`](../ARCHITECTURE.md) 画的 `apps/agent/src/<module>` 结构是：

```
app / ops / agent / napcat / llm / metric / scheduler / oss-client / auth / logger / db / config / common
```

配套的「关键模块速览」表还逐个描述了 `acl` / `common` / `llm` / `napcat` / `scheduler` / `agent` / `ops` / `app` 八个模块。

**实际 `apps/agent/src` 只有 4 个目录 + 1 个文件**：`acl/`、`agent/`、`app/`、`ops/`、`index.ts`。
`napcat` 已在 issue #347 外移成独立进程（`apps/napcat`）、`llm` 外移成 `apps/llm`、`metric` 外移成 `apps/metric`、
`scheduler` 外移成 `apps/scheduler`、`auth` 成了 `packages/auth`、`db` 成了 `packages/persistence`、
`logger`/`config`/`common` 进了 `packages/kernel`。文档描述的是拆分前的形态。

**2. scheduler「无 DB」的说法有三处，全部与代码矛盾。**

- [`ARCHITECTURE.md:19`](../ARCHITECTURE.md)：「apps/scheduler ──→ packages/kernel / http / scheduler-api（独立进程，通用定时调度薄时钟；**无 DB**、无业务语义）」
- ARCHITECTURE.md 包表：「**无 DB**、纯内存派生态」
- ARCHITECTURE.md 部署段：「`kagami-scheduler`……**无 DB**、纯内存派生态」「scheduler 无持久化」
- [`ecosystem.config.cjs:136`](../ecosystem.config.cjs)：「通用薄时钟，**无 DB**、无业务语义」

实际上 scheduler **有自己独立的 Prisma 数据库**：
[`apps/scheduler/prisma/schema.prisma`](../apps/scheduler/prisma/schema.prisma) 定义 `TaskRun` model、
有迁移 `20260706171838_init`、
[`apps/scheduler/package.json`](../apps/scheduler/package.json) 依赖 `@prisma/client` / `better-sqlite3` / `prisma` 并有 4 条 `db:migrate:*` 脚本、
[`apps/scheduler/src/infra/db/task-run-store.ts`](../apps/scheduler/src/infra/db/task-run-store.ts) 是完整的存储层、
[`config.yaml:22`](../config.yaml) 配了 `services.scheduler.databaseUrl: file:./data/sqlite/scheduler.db`。

从 schema 注释看，这是 **issue #493 后加的**（「一次任务执行的历史记录（scheduler B P1，issue #493）」），
文档停留在 #428 初版的「纯薄时钟」描述。ARCHITECTURE.md 的包表其实已经提到了 #493 的 `TaskRun`
（在 `@kagami/scheduler-api` 那行），说明是**部分更新后遗留的不一致**。

**3. `hnswlib-node` 在两处文档里被写成必需的原生依赖，但不是任何包的依赖。**

- [`README.md`](../README.md)：「a toolchain that can compile native modules (`better-sqlite3`, `hnswlib-node`)」
- [`ARCHITECTURE.md:231`](../ARCHITECTURE.md)：「部署机需能编译原生模块（better-sqlite3、hnswlib-node）」

全仓库对 `hnswlib` 的引用只有一处：[`pnpm-workspace.yaml:12`](../pnpm-workspace.yaml) 的 `onlyBuiltDependencies` 列表。
没有任何 `package.json` 依赖它，没有任何 `.ts` import 它。这是"记忆系统"计划的残留——
配合上面「embedding 无消费方」那条，可以确认向量记忆是**已铺好基建但从未接线**的状态。
（同列表里的其余条目均为真实依赖，如 `cloakbrowser` 确实是 [`apps/browser/package.json:20`](../apps/browser/package.json) 的依赖——只有 `hnswlib-node` 是孤儿。）

**4. ARCHITECTURE.md 工作区拓扑图漏列了两个 api 包。**
[`ARCHITECTURE.md:9`](../ARCHITECTURE.md) 写 agent「→ packages/http + 各 *-api 契约包（llm/browser/oss/spire/metric/pixel/agent-api）」，
漏了 `napcat-api` 和 `scheduler-api`——两者都在 [`apps/agent/package.json`](../apps/agent/package.json) 的依赖里。

### Holly

**5. README 说记忆存在 Qdrant，实际已迁到 SQLite，且从来不是"可检索"的向量库。**
[`Holly/README.md:3`](../../Holly/README.md)：「keeping a **searchable memory trail in Qdrant**」，
中文段：「将消息写入 **Qdrant** 以便后续**检索**和上下文记忆」。

实际：`database.provider: sqlite`（[`config.yaml:129`](../../Holly/config.yaml)）已切换；
且即便在 Qdrant 时期也「not for nearest-neighbour search」（[`qdrant-store.ts:62`](../../Holly/qdrant-store.ts)），
存的是无向量 point，读用 `scroll` 不用 `search`。"searchable" 指的是**按 group/user/type 过滤**，不是语义检索。

**6. README 说用 Codex profile 决定是否回复，实际 active 是 Claude。**
[`Holly/README.md`](../../Holly/README.md)：「Uses a configurable **Codex-backed** LLM profile to decide whether a reply is needed.」
实际 `llm.active: claude_opus`（[`config.yaml:29`](../../Holly/config.yaml)）。
Claude provider 是 2026-05-21 才加的（commit「Add Claude provider with subscription OAuth and structured outputs」），README 未跟进。

**7. 项目有三个名字。**
`package.json` 的 `name` 是 `pybot-ts`（[`Holly/package.json:2`](../../Holly/package.json)），
README 通篇叫 `tsbot`，repo / 代码里的实体叫 `Holly`。
`main.py`（10,685 字节，Flask + `google.genai`）是遗留的 Python 前身——`pybot` → `pybot-ts` 的命名残留，
它已不被任何东西引用。

**8. README 列的功能清单落后于代码。**
README 的能力清单没有提到：自主性引擎（`autonomy-engine.ts`，世界观察 / 记忆反思 / 自主写作）、
主动发言引擎（`proactive-engine.ts`）、浏览器 agent（`browser-agent.ts`）、
ai-tone 打分、域名信誉、QQ 模式自决。这些都是 2026-06 之后加的，README 最后更新在 2026-08-21 但内容仍是早期形态。
（README 确实提到了 `/改进代码` 和思考时间线，说明是**部分更新**。）

**9. `codex-provider.ts` 是不参与构建的孤儿文件。** 详见第 3 节。tsconfig 显式排除、
import 路径不可解析、无 dist 产物、零引用。它的存在会误导任何按文件清单理解 Holly 架构的人
（包括本次调研任务的原始描述）。

---

## 如果要把能力在两者之间迁移

### 方向 A：把 Holly 的能力搬到 kagami（原任务设想的方向）

需要注意的是，kagami 是 `Hei-AI/kagami` 上游仓库，本地 checkout 无本用户的任何 commit。
以下按"技术上还差什么"列出，不考虑仓库归属问题。

**几乎可以直接搬（纯逻辑 + 已有测试）：**

- `search-intent.ts`（188 行）→ 可作为 kagami 一个新 capability 的 domain 层。零依赖，7 条正则 + 单测齐全。
- `world-observation-dedup.ts`（154 行）→ 同上，URL 归一化逻辑通用。
- `domain-reputation.ts`（155 行）→ 需把 JSON 文件存储换成 `AppState` 表（kagami 已有通用 KV 表）。

**需要重新设计成工具的：**

- **自主性引擎**。Holly 的 `runAutonomyLoop` 是"代码决定做什么、模型填内容"，kagami 是"模型决定做什么"。
  直接移植会和 ReAct 范式打架。可行的做法是把四个检查项拆成 kagami 的 scheduled task
  （`@kagami/scheduler-client` 已支持 interval + cron），tick 到点后**注入一条通知**让模型自己决定要不要行动，
  而不是代码直接执行。
- **主动发言的退避状态机**（`holly-state.ts`）。这个状态机本身很有价值（观察窗 + 指数退避 + 每日配额 + TTL），
  kagami 的 `messaging` capability 目前只有 ai-tone 门控，没有节流。可作为 `send-message.tool.ts` 的前置 gate 移植，
  状态落 `AppState`。
- **SearXNG 搜索**。kagami 没有独立搜索能力（只有 browser 工具）。移植成本低：加一个 `search.tool.ts` + 一个配置项。

**明确不建议移植的：**

- **`admin-code-worker.ts`（自主改代码）**。Holly 是单文件平铺 + tsx 直跑，改完代码重启即生效；
  kagami 是 12 个 app 的 monorepo，改代码要 `pnpm build` + 可能的 `prisma migrate` + PM2 reload 11 个进程。
  `PROTECTED_PATHS` 那套白名单在 monorepo 里也难以覆盖（改一个 `packages/*` 会影响多个 app）。
  kagami 已有的 `terminal` capability（`bash.tool.ts`）在能力上是超集，风险模型完全不同。
- **QQ 模式自决**。依赖 Holly 的单进程 WS 所有权；kagami 的 WS 在独立的 napcat 进程里，agent 无法直接断开它。

**kagami 侧的前置缺口：** 如果要接 Holly 那套「记忆反思」，kagami 得先把记忆系统接线
——embedding 基建齐了但没有任何存储 + 检索层（见第 4 节）。这是最大的一块空白。

### 方向 B：Holly 继续从 kagami 借鉴（代码显示的真实方向）

Holly 已经借了 NotificationCenter 模型、私聊 fail-closed 边界、SQLite 主存、Claude prompt cache 策略。
按当前差距，收益最高的下三项：

1. **给 LLM 层加工具调用。** 这是 Holly 最大的架构天花板——目前每加一个能力就要在 `main.ts` 里写一段硬编排。
   kagami 的 `packages/llm`（100 行的类型契约）+ `tool-component.ts`（工具接口）是可以照抄的最小集。
2. **配置隐私迁移已完成。** 真实值留在 Git 忽略的 `config.yaml` / `.env`，仅提交 `.example` 模板。
   运行时仍读取和写回同一个本地配置文件；历史记录与 GitHub 缓存清理也已完成。
3. **加 lint + CI。** Holly 完全没有 eslint / prettier / CI。以 44 commits 的体量现在加成本最低；
   `codex-provider.ts` 这种孤儿文件正是 knip 一跑就能发现的。

### kagami 相比 Holly 引入的复杂度成本

诚实地列一下拆分的账单：

1. **约 4,500 行纯管道代码。** 9 个 `*-api` 契约包（66~584 行不等）+ `rpc-client`(842) + `http`(981)。
   在 Holly 里这些是零——同进程函数调用不需要契约。
2. **11 个进程的运维面。** 每个进程要 PM2 条目、端口分配、健康检查、绑定地址决策、优雅关停。
   `config.yaml` 的 `services:` 块是 17 行的拓扑表，Holly 只有一个写死的 `127.0.0.1:5000`。
3. **跨进程错误传递的间接性。** BizError 经 `toBizErrorWire → bizErrorFromWire` 往返只重建基类，
   `instanceof 子类` 失效，逼出 `meta.retryable` 这种结构化标记方案
   （[`retryable-error.ts:11-13`](../packages/llm-client/src/retryable-error.ts)）。Holly 里 `error instanceof X` 直接可用。
4. **入站事件的 at-least-once 基建。** outbox 表 + seq + Last-Event-ID 回放 + SSE 背压处理
   （[`napcat-events.handler.ts`](../apps/napcat/src/http/napcat-events.handler.ts)）——
   单进程里"收到消息就处理"这一步，拆进程后需要一整套可靠投递协议。
5. **两个 Prisma 库。** 主库 + scheduler 库，`scripts/prisma.sh` 靠环境变量参数化复用；
   并发读写靠 SQLite WAL。Holly 一个 `DatabaseSync` 实例搞定。
6. **构建期耦合。** `apps/gateway` build 时要把 `apps/web/dist` 拷进自己的 `dist/public`
   （`scripts/copy-web-dist.mjs`），CI 每条 leg 都得先 `pnpm build` 才能跑检查——
   注释承认这是「用冗余计算换零耦合拓扑」。
7. **部署顺序约束。** [`ARCHITECTURE.md:229`](../ARCHITECTURE.md) 记录「有 DB 迁移时 `deploy.sh` 会连
   `kagami-llm` / `kagami-metric` 一并停服再迁」——多进程共库带来的停服协调。

这些成本换来的是：单个能力崩溃不拖垮全局（browser 崩了 agent 还活着）、
agent 重启不打断 WS 连接 / 对局 / 画布 / 计时、契约变更编译期报错、以及 1,439 个用例能真正跑起来
（Holly 的 8,762 行编排层测不了，正是因为它和 IO 绑在一个进程里）。

对 Holly 这种 44 commits、单人、单机自用的项目，这套成本大概率不划算；
对 kagami 这种 1,419 commits、12 个 app、有 CI 的项目，它是让改动可控的必要开销。
**两者不是"新旧版本"，是两个不同规模阶段上的合理解。**
