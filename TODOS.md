# TODOS

> 设计来源:`<local-design-notes>/35702-main-design-20260623-164438.md`(主动式 Holly 切片1)
> 测试计划:`<local-design-notes>/35702-main-eng-review-test-plan-20260624-200235.md`
> 经 /plan-eng-review:6 项硬化 + codex 外部意见,全选完整方案(Lake 7/7)。

## 主动式 Holly · 切片1(冷场接被冷掉的兴趣话题)

实现顺序大致 T1→T13。全部 P1 都要带测试 + 错误处理。

### 引擎与状态
- [ ] **T1** 抽 `holly-state.ts` + `proactive-engine.ts`,用 deps 对象注入(不再往 4266 行的 main.ts 里塞)。main.ts 只组装 deps + 挂 tick。
- [ ] **T2** `hollyState`(per-group:`lastProactiveAt`/`todayProactiveCount`/`backoffLevel`/`engagedThreadKeys`/`pendingObservation`)+ **原子** JSON 持久化。损坏 JSON → 默认值不崩。`todayProactiveCount` 带**日期+时区键**。
- [ ] **T3** tick 遍历 `conversationHistoryByGroup` 作**活跃群注册表**(不是 `unreadModelMessagesByGroup`——冷场群恰好没未读),逐群算 `lull`。
- [ ] **T4** 纯规则限流闸:echo-only 群(20000003)/ 最后一条是 Holly / `lull<M` / `lull>死区` / 无近期兴趣话题 / 已接过 / 超日上限 / 冷却中 / backoff 中 / **全局每日总上限**。

### 决策与发送
- [ ] **T5** 门控B 调模型:复用反应式**同一套缓存 system+history 前缀**(`prepareModelRequest`),指令只走 user 当前消息 → 命中 1h 缓存,不重处理 ~850K 上下文。
- [ ] **T6** 发送前复查:`lull` 仍有效 + 最后一条非 assistant + eval 后无新用户消息 + 无 pending 反应式发送 + Holly 近期没发。任一不满足 → 静默放弃。
- [ ] **T7** 观察窗 + 退避(tick 驱动,读 `conversationHistoryByGroup`):成功 = **更短窗口 X 内**有 `role==user` 回应(不是"此后任何消息");无人 → `backoff++`。温和档:被无视 → 阈值 +50%,一次成功清零。
- [ ] **T8** LLM 输出后置校验:机械强制单行、禁多行、禁 @ 轰炸、禁疑问轰炸。不合格不发。

### 安全上线(本轮最大改动)
- [ ] **T9** `proactive_mode: shadow | live`。**shadow**:照常算 + 写日志 + **不发**,跑几天自动攒 ground-truth。**live**:先只在 1 个白名单群、用更低的 cap。
- [ ] **T10** 可观测性遥测:skip 原因计数、aborts、sends、ignored/success、队列等待、token/缓存命中。没这个没法安全调 C 档参数。

### 测试与配置
- [ ] **T11**(CRITICAL 回归)建 `node:test`(零新依赖)+ 单测全部克制逻辑(skip 条件 / 复查 / 退避结算 / state load-save 含损坏 JSON)+ **回归测试:把现有反应式回复包成 replyAction 后行为不变**。
- [ ] **T12** 门控B 的 LLM eval(should_reply 合理 + final_answer 是自然中文短句、不退化)。
- [ ] **T13** 全部新参数进 config.yaml + 接 config watcher 热加载(P4)。

## 延后(切片1 不做,记下避免丢)
- [ ] **模型队列优先级**:主动调用降级为低优先、可取消,别拖慢真实对话延迟。*Why:* 多群维护不能挤占反应式回复。*现状:* 单群灰度下队列压力小,故延后。
- [ ] **`engagedThreadKeys` 驱逐**:1 小时内不重复同一话题,但下周同主题可重来。*Why:* 否则 key 无限增长或永久压制。
- [ ] **kill switch / per-group 配置**:管理员一键停、按群开关/调参。*Why:* product 风险,不是实现细节。
- [ ] **"thread/话题对象"精确定义**:关键词命中?连续交流?参与人数?最后用户贡献?*Why:* 决定 `engagedThreadKeys` 和"已接过"的语义(设计 Open Q2)。

## 后续切片(上一份架构文档)
- [ ] 动作 2:Holly 自己开兴趣话题
- [ ] 动作 3-5:主动私聊 / 自己看世界 / 记忆整理(Action 插件)
- [ ] 切片2::5000 的"Holly 主页"活状态页(内在状态时钟)
