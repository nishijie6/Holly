# 本地数据库

Holly 可以像 Kagami 一样使用进程内 SQLite 文件作为主要记忆库，同时保留
Qdrant 后端作为可切换选项。

## 配置

项目要求 Node.js 26 或更新版本。首次运行将 `config.example.yaml` 复制为本地 `config.yaml`；
真实配置和运行时数据均被 Git 忽略。数据库路径相对于 `config.yaml` 所在目录
解析，不受启动命令当前工作目录影响；运行时 `data/` 目录不会提交到 Git。

```yaml
database:
  enabled: true
  provider: sqlite
  url: file:./data/sqlite/holly.db
  timeout_ms: 5000
```

如需切回 Qdrant，将 provider 改为 `qdrant`，原有 `qdrant` 配置继续生效：

```yaml
database:
  enabled: true
  provider: qdrant

qdrant:
  url: http://127.0.0.1:6333
  collection: ws_incoming_messages
  timeout_ms: 10000
```

## 从 Qdrant 迁移

切换前可执行：

```powershell
npm run db:migrate:qdrant-to-sqlite
```

迁移只读取 Qdrant，不会删除或修改云端数据。Qdrant point ID 会作为 SQLite
主键保留，因此命令可重复运行而不会产生重复记录。
