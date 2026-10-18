# 代码反向审查记录（2026-10-18）

这份文档从当前代码、测试、配置和 API 反向提炼产品设计，不等同于“已完成清单”。
标记为“基础已实现”的能力仍可能缺少管理面、持久化、接线或生产级恢复语义；准确的后续项同步记录在 [`REMAINING_WORK.md`](../REMAINING_WORK.md)。

## 1. 已实现的设计

### 1.1 人格、关系与状态

- `src/emotion/`：好感、亲密度、八维情绪、关系阶段、态度和语气注入。
- `src/admin/world.ts`：世界状态、日程、确认事件、阶段 tick、energy/stress 演化。
- `src/admin/device.ts`：电量、充电、网络、屏幕、勿扰、活动和通知延迟模拟。
- `src/admin/daily-life.ts`：低戏剧性日常活动 proposal；模型失败回退到规则，禁止自行生成新闻、灾难和大型公开活动。
- `src/pipeline/social-decision.ts`：direct summon、房间问题、主动参与、energy/stress、设备延迟、peer-bot 冷却。
- `src/pipeline/talk-governor.ts`：默认关闭的频道主动发言预算、冷却和退避。
- `src/social/disclosure.ts`：角色互询安全判定，要求 shared scope、双方 affinity、对方 opt-in 和内部通道。

### 1.2 记忆、消息生命周期与隐私

- `SemanticMemoryAdapter`：private/relationship/shared scope、频道域授权、embedding/rerank 降级。
- `ExpressionMemoryAdapter`：低风险表达偏好规则抽取、approved-only recall、TTL、fingerprint 去重、频道/用户/Bot 隔离、敏感信息与 prompt injection 过滤。
- `ProfileReflectionWorker`：确定性偏好/称呼提取和敏感词 fail-closed。
- `SessionManager`：消息来源 ID、编辑、删除 tombstone、滚动摘要、未来版本只读保护。
- `MessageSync`：Discord message index、thread/forum/guild/DM location 规范化、迟到 edit 不覆盖 delete。
- `privacyGate`：第三方隐私、跨频道内容和敏感请求拦截。
- `src/media/vision.ts` 与 `src/media/runtime.ts`：VLM/OCR 结果标记为 `untrusted`，大小/URL/缓存/降级边界明确。

### 1.3 执行平面与运维

- 普通聊天 ReplyPlan 平面：只允许 `ignore` 或受限 segments，发送器负责 mention、分段和失败降级。
- LLM tools 平面：`ChatToolRegistry`、有界 tool loop、allowlist、MCP viewer 映射。
- MCP 平面：真实 stdio/http transport、权限、审计、脱敏和模型桥接。
- Operator 平面：诊断、受控 patch/config/restart、ReAct agent、跨进程确认、ACP/WebUI 适配。
- ACP/OpenCode 平面：外部 Agent 连接能力，但不应继承聊天模型或 Operator 权限。
- Provider 平面：multi-router、fallback、circuit breaker、model catalog、health coordinator、usage/cost 统计。
- 配置发布状态机：revision、digest、ACK/NACK、quorum/target rollout、超时、回滚和 transition history。
- Discord Guild Plan：服务器 inventory 和非破坏性频道规划/执行器，禁止删除频道、成员、角色和权限。

## 2. 已有设计但尚未闭环

### 2.1 世界模拟

当前已有 `WorldStore`、`world-tick`、`world-events`、`DailyLifeSimulator`、`day-planner`、
`event-intelligence`，但它们还不是完整的持续世界模拟系统：

```text
日常/外部事件候选
  -> 信任与管理员确认
  -> 世界状态/日程
  -> tick 阶段与 mood 变化
  -> Future Task/内部事件
  -> 行为、情绪、社交决策和回复
```

尚未闭环的部分：

- DailyLife proposal 没有接入 runtime/world tick，也没有统一确认和写回流程。
- 外部事件候选、日常活动、已确认日程和内部事件没有统一来源链与回放模型。
- 世界状态和设备状态仍由 `VersionedJsonStore` 保存，与 SQLite-only 目标不一致。
- 事件阶段有 `appliedPhases` 幂等保护，但跨进程、多实例和 stale cache 语义未解决。
- Future Tasks 尚未作为世界事件的可靠执行层。
- 多 Bot/多频道世界域的共享/隔离策略尚未定义。
- 世界事件尚未统一写入 trace、审计和可回放记录。

### 2.2 角色互询

`mayConsultPeer()` 已提供安全门，但实际链路仍缺：

- 发起角色选择可询问对象。
- 内部询问消息和回复超时/失败处理。
- 只返回抽象 shared facts 的答案生成。
- disclosure audit 和来源追踪。
- 与 Expression/Semantic Memory 删除及 scope 授权联动。

现有管理员驱动的 `cross-chat` 是公开的多角色娱乐对聊，不等同于角色互询。

### 2.3 Guild Workspace Planner

`buildInternalGuildPlan()` 和 `DiscordGateway.applyGuildPlan()` 已存在，但控制面不完整：

- 没有 AdminServer 的 inventory/plan/apply 路由。
- 没有统一 RBAC、二次确认和审计接线。
- 没有部分失败后的恢复/回滚计划。
- 执行前后没有稳定的 inventory digest 和幂等变更记录。

### 2.4 Expression/Jargon Learning

当前 Expression Memory 只是低风险用户偏好规则记忆，不是 MaiBot 式表达/黑话学习：

- 尚无 expression 与 jargon 分离模型。
- 尚无群体表达样本、phrase/intent、source author、sharing group。
- 尚无 candidate 审核、启用/禁用、归档和回滚。
- 尚无向量召回和语境选择。
- 尚无私聊不进入群共享的完整策略和管理面。

### 2.5 消息删除与长期记忆

`MessageSync` 和 `SessionManager.deleteSourceMessage()` 只处理 message index 和短期 session。
Semantic/Expression Memory 没有统一 `sourceMessageId` 删除联动，因此：

- 删除原始消息后长期记忆可能仍然存在。
- 异步 embedding 或派生写回可能复活已删除记录。
- profile/reflection 事实没有完整 provenance 删除路径。

## 3. 已确认的代码风险和技术债

### 3.1 持久化和并发

- `WorldStore`/`DeviceStore` 使用 JSON 文件；`VersionedJsonStore` 的串行队列只在当前进程有效。
- World/Device 2 秒 TTL cache 会造成多实例短暂旧读。
- `WorldStore.event()` 使用时间戳加随机数，不是跨进程严格幂等 ID。
- 配置发布 Runtime 当前使用 `InMemoryPublicationStateStore`，进程重启会丢失 revision、ACK、pending 和 rollback。
- 配置发布状态机记录“发布状态”，但没有自动保证“实际运行配置已激活”。
- `BotRuntime.applyConfig()` 只更新下一次重启使用的配置，不能动态重建所有已运行组件。
- Future Tasks 尚无 SQLite atomic claim、lease、recovery 或 execution history。

### 3.2 异步和生命周期

- 插件 hook timeout 只停止等待，无法强制终止仍在运行的 JavaScript promise/副作用。
- Discord 出站 `Gateway.send()` 当前不能完整表达 delivered/rejected/unknown；进程在发送成功和状态提交之间崩溃时无法保证 exactly-once。
- `DailyLifeSimulator` 只有 proposal，不承担持久化、取消、确认或恢复。
- 世界 tick、Future Task、主动发言尚未形成统一的取消、超时、重试和审计状态机。

### 3.3 权限、审计和管理面

- 管理插件命令仍需要统一用户/角色 allowlist、频道限制和命令级限流。
- Guild Plan 执行器没有完整 API/确认/审计闭环。
- Expression Memory 没有 pending/approved 管理 UI、批量删除、回收站和导出。
- 记忆删除没有来源过滤、影响范围预览和派生数据清理报告。
- 配置发布需要持久化状态、实际激活回执和组件重建结果。
- OpenCode/ACP/MCP/Operator/聊天工具已有局部边界，但缺统一权限矩阵和端到端越权回归。

### 3.4 模型和多模态

- Model catalog、health、circuit、fallback、usage 已存在，但没有统一 Model Operations 视图和跨 Bot/provider 运营契约。
- `TASK_TUNING` 与 provider availability overlay 没有完整接到所有管理/自动选择路径。
- 用户文本、OCR/VLM、MCP、工具返回和长期记忆都标记/处理为不可信的程度不同，尚无统一 prompt data/instruction 协议和全链路测试。
- Vision cache 是派生状态；cache 失效、provider 变更和观察版本之间没有统一 provenance。

## 4. 后续路线

### P0：数据与可靠性

1. World/Device JSON 迁移 SQLite，补跨实例冲突和 cache 策略。
2. 配置发布持久化、实际激活回执、组件动态重建和 rollback。
3. MessageSync tombstone 联动 Semantic/Expression/Profile Memory。
4. Future Tasks 的 SQLite 状态机、atomic claim、lease、unknown/reconcile。
5. 插件 AbortSignal/副作用生命周期终止语义。

### P1：沉浸闭环

1. DailyLife 接入 World tick 和 Future Tasks。
2. 角色互询实际调用、抽象回答和 audit。
3. Guild Workspace Planner 的控制面和审计。
4. Expression/Jargon 学习、审核、召回和共享组。
5. Planner、Topic relevance、Focus lease 和主动出站队列。

### P2：治理和运营

1. 记忆回收站、批量删除、导出/导入和 provenance。
2. 统一不可信数据协议及注入回归测试。
3. Model Operations WebUI、跨 Bot 健康/成本/延迟视图。
4. Discord delivery unknown reconcile 和可审计重试。
5. `chat_log` 保留期、容量、查询权限和用户删除策略。
