# 遗留清单（2026-10-18 更新）

## 全部完成 ✅
- [x] 终极闭环：Discord 群里 @墨染荷韵 说话 → `GET /api/ops/discord-chat-log` 出现 in+out 记录
- [x] 管理端 Discord 入站/出站聊天日志
- [x] 端到端验证：console 全链路真实进程冒烟通过
- [x] 上游对比：见 UPSTREAM_COMPARE.md
- [x] 10 月功能批：emotion / persona_ab / usage / songs / search / fun / welcome / bilibili / broadcast / ban / repeat-guard / opencode-cli / ACP / SQLite-only / data 单卷 / 滚动摘要 / secret 扫描
- [x] peer-bot summon 修复
- [x] MCP 基础设施（qcfr + jev）
- [x] Operator Agent Phase 0：框架骨架（registry/tools/?op/20 测试）
- [x] Operator Agent Phase 1：diag 工具（health/tail/why，接入 traces/sessions）
- [x] Operator Agent Phase 2：patch/config 受控读写（路径安全、禁 .env*/DB）
- [x] Operator Agent Phase 3：restart 工具（重启前 typecheck+test 门禁）
- [x] Operator Agent Phase 4：agent loop（ReAct，`?op agent <goal>`，最多 8 步，写操作暂存）
- [x] Phase 5 部分：审计 API（`GET /api/ops/operator-audit`）
- [x] 已知 bug 修复：`<@id>` mention 残留；好感度数字滞后（cooldown/interval 默认调优）
- [x] 第一批拟人化基础：Expression Memory（规则抽取、隔离、TTL、去重、安全过滤）+ Talk Governor（默认关闭的主动发言预算/冷却）

## Operator Agent Phase 5 ✅（2026-10-17 全部收口）

### 可并行（互不冲突）— 均已完成
- [x] ACP server 接入 operator — `src/acp/**`：`tools/list` + `tools/call`，经 `src/acp/operator-tools.ts` 适配（read 直跑，write/danger 拒绝并说明），`agentCapabilities.tools: true`
- [x] opencode-cli provider 接入（用 agent 当 model）— `src/ai/opencode-cli.ts`：`options.agent` 生效时以 `opencode run --agent <name>` 取代 `-m <model>`（agent 自带模型/工具配置），standalone 回退保留 `--agent`，构造期校验 agent 名（防 flag 注入）
- [x] WebUI 审计视图 — `webui/`：新增「运维审计」页（可用工具表 + 调用记录表），数据来自 `GET /api/ops/operator-tools` 与 `GET /api/ops/operator-audit`，`audit.read` 权限门控
- [x] 端到端测试：agent 诊断真实流程 — `plugins/operator/agent.e2e.test.ts`（3 例：多步诊断 / 写操作暂存待确认 / 未知工具恢复）

### 顺序/集成 — 均已完成
- [x] operator 工具句柄注入 plugin-context/provider 通道：registry + tools 上移为 `src/operator/` 单一事实来源（插件 `plugins/operator/*.ts` 仅 re-export），ACP server（`src/acp/index.ts`）与 admin WebUI（`GET /api/ops/operator-tools`）共用同一套工具；共享 `createSpawnExec()`（`src/operator/exec.ts`）
- [x] `?op agent` 写操作暂存的跨进程确认：`stage()` 落盘时打上进程 bootId，`consume()` 校验——进程重启（或旧版本遗留的 pending）一律失效并清除，提示重新发起；模块态 bootId 只随真实重启轮换，插件热重载不受影响
- [x] 集成收尾：根套件 120 文件/787 测试、插件套件 6 测试、双 typecheck、`scan-secrets` 全部通过后，`plugins/operator/plugin.json` 默认启用（`?op` 仍双重门控：pipeline `?` 管理路由 + registry `isAdmin` 校验）

## 决策记录
- ~~需人动手：Kilo 凭据吊销~~ → **2026-10-17：Kilo 账号不可用、凭据无法吊销，按失效凭据接受残留风险，不再跟进**（详见 `docs/AUDIT.md` 决策记录；可选加固 `git filter-repo` 清史属非必须）。

## README 路线图收口（2026-10-17）
原 6 阶段长期方向，本轮补齐缺口：
- [x] 角色互聊 — `src/characters/cross-chat.ts` + `POST /api/characters/cross-chat`（轮转调度、硬回合上限、重复检测、超时熔断、沙箱 system prompt），权限 `characters.crosschat`
- [x] 角色批量导入 — `src/characters/import.ts` + `POST /api/characters/import`（逐项校验/批内去重/dryRun/冲突 skip|overwrite/单项失败隔离），权限 `characters.import`
- [x] MCP 工具权限与审计 — `src/mcp/`：client/permissions/audit + **真实 transport**（`StdioTransport`/`HttpTransport`）+ `McpManager`（多 server、共享审计、单 server 失败隔离），config 驱动（`mcp.enabled` 默认关闭，见 `docs/MCP.md`）；管理面 `GET /api/mcp/policy|tools|audit` + `POST /api/mcp/call`（二次确认），权限 `mcp.read`/`mcp.call`
- [x] 前端补齐 — WebUI 角色页新增「新建 / 批量导入 / 角色互聊」，新增「MCP 工具」页（`webui/`，按权限门控）
- [x] 服务端集成测试 — `src/admin/server.test.ts` 覆盖 import / cross-chat / mcp tools·audit·call（含拒绝与未知 server）
- [x] 文档卫生 — `webui/index.md` 按代码实况重写；修正 `docs/AUDIT.md`「未实现」过期断言与 `docs/EXTENDING.md`「HTTP API/WebUI 不在范围」过期边界；新增 `docs/MCP.md`

剩余（非阻塞，已评估、按需再做）：
- [x] LLM 工具调用进回复 pipeline（通用路径）— `src/ai/tools.ts`（`ChatToolRegistry` + `executeToolCall`）+ provider tools 支持（非流式）+ pipeline 有界工具循环（`ai.tools.enabled` 默认关，allowlist + maxRounds）+ 内置 `search_song`；移植自 upstream `llm_tools.py`
- [x] 回复产物过滤器 — `src/pipeline/reply-filter.ts`，移植自 upstream `reply_filter.py`（FORMAT/DROP/VOICE 三类，流式安全、比较式不误伤、嵌套 drop、超长救援），`ai.replyFilter` 默认开
- [x] 把 **MCP 工具**桥接进 `ChatToolRegistry` — `src/ai/mcp-tools.ts` 将 MCP server 工具注册到模型工具表；模型调用继续经过 MCP 权限门与审计，模型调用者固定为低权限 `viewer`；`src/ai/mcp-tools.test.ts` 覆盖 schema、调用、拒绝与审计
- [x] Expression Memory 基础闭环 — `src/memory/expression-memory.ts`：低风险显式表达规则抽取、approved-only recall、频道/用户/Bot 隔离、TTL、fingerprint 去重、敏感信息与 prompt injection 过滤；默认不启用，尚无 LLM 审核/管理 UI
- [x] Talk Governor 基础层 — `src/pipeline/talk-governor.ts`：默认关闭，仅治理主动群聊插话，按频道预算/冷却/连续发言退避；direct summon、房间问题和 peer banter 默认不受影响
- [ ] Expression Memory 完整治理：pending/approved/rejected 审核流、黑话/表达学习、来源消息删除联动、批量删除/回收站/导出、向量召回和 WebUI 管理
- [ ] 消息级 Planner：本地隐私/权限/设备 gate 之后，增加有界的 `ignore|reply` 结构化决策；不能绕过 direct summon、repeat guard、ReplyPlan 和工具权限
- [ ] Talk Governor 第二阶段：IANA 时区 quiet hours、topic relevance、Focus lease、主动消息队列，以及 Future Task 出站二次治理
- [ ] Future Tasks：SQLite 持久化任务/执行记录、原子 claim、lease/recovery、owner 隔离、重试/超时/uncertain 状态；再接模型工具、管理 API 和 Discord 投递
- [ ] 记忆治理：按用户/频道/来源批量删除、tombstone/回收站、删除审计、派生 embedding 清理、脱敏导出与 dry-run 导入
- [ ] MessageSync 删除联动：当前 `src/session/message-sync.ts`/`SessionManager.deleteSourceMessage()` 只处理原始消息索引和短期 session；需让 semantic/expression memory 按 `sourceMessageId` 删除或 tombstone，且阻止异步派生数据复活
- [ ] 世界模拟 Phase 0：把当前 `WorldStore`/`world-tick`/`world-events`/`day-planner` 收敛为可测试的状态机和事件模型，补齐事件来源、信任、时间区间、阶段幂等和回放测试
- [ ] 世界模拟 Phase 1：将 `WorldStore` 从 `VersionedJsonStore` 迁移到 SQLite（当前架构声明 SQLite-only，但世界/设备状态仍是 JSON 文件），保留迁移备份和旧数据兼容
- [ ] 世界模拟 Phase 2：确认事件 → 持久化 Future Task/内部事件 → 状态演化 → 行为/情绪/发言决策；避免 `world-tick` 重复生成事件或重复扣除状态
- [ ] 世界模拟 Phase 3：角色日程、地点/活动、天气/情报候选、关系事件和长期世界记忆的来源链、置信度、过期与管理员确认
- [ ] 世界模拟 Phase 4：多 Bot/多频道世界域隔离或共享策略、事件抢占/恢复、可观测 trace、管理员 dry-run 和完整端到端回放
- [x] 世界模拟辅助基础已存在但尚未完整接线：`DailyLifeSimulator` 提供低戏剧性日常活动与规则回退；`event-intelligence` 提供事件候选/证据/信任合并；`day-planner` 提供规则日计划
- [x] 角色互询安全闸门已存在 — `src/social/disclosure.ts`：仅 `shared`、双方 affinity >= 70、对方 opt-in 且存在内部通道；实际询问/抽象回答/审计接线仍未完成
- [x] Discord 服务器规划器已有非破坏性 plan — `src/discord/guild-admin.ts`：只生成创建/移动/topic 计划，保留现有频道，不删除权限/成员；实际确认执行、回滚和审计仍未完成
- [x] 消息生命周期索引已有 tombstone — `src/session/message-sync.ts`：编辑/删除幂等、迟到 edit 不覆盖删除、thread/forum/guild/DM location 规范化；尚未与长期记忆、Expression Memory 的来源删除联动
- [x] 配置发布状态机已有基础实现 — `src/config/publication-state.ts`：digest、revision、quorum/target ACK、超时回滚、transition history；仍需补运行时组件激活/重建和生产多节点接线说明
- [x] 多模态结果已标记为不可信观察 — `src/media/vision.ts`：OCR 使用 `trust: 'untrusted'`，VLM/OCR 独立降级，缓存为派生状态；仍需与统一 prompt injection/记忆安全协议收敛
- [x] 模型运营基础已存在 — model catalog、health coordinator、multi-router、circuit breaker、fallback、usage/cost 统计；仍缺一份统一 Model Operations 规格和跨 Bot/provider 的运营视图
- [x] OpenCode/ACP/MCP/Operator 已形成独立执行平面：聊天模型、外部 Agent、MCP viewer、Operator admin 权限边界分别存在；仍需补统一权限矩阵和端到端越权回归
- [ ] Expression/Jargon 学习拆分：当前 Expression Memory 仅是用户偏好规则记忆，尚未实现群体表达样本、黑话含义、source author、sharing group、candidate 审核和向量召回
- [ ] DailyLifeSimulator 接入 World tick：无活动日生成日常活动，写回地点/活动/energy/stress，并通过 Future Tasks/事件机制驱动后续状态
- [ ] Social Disclosure 实际调用链：使用 `mayConsultPeer()` 生成仅含抽象 shared facts 的内部询问，禁止私聊 transcript/diary/relationship notes 泄露，并写 disclosure audit
- [ ] Guild Workspace Planner 执行层：inventory → dry-run plan → 管理员确认 → Discord API 执行 → 结果审计/可回滚；不得删除频道、成员、角色或权限
- [ ] 统一不可信数据协议：用户文本、OCR/VLM、MCP 返回、长期记忆、工具结果都必须作为 data 而非 instruction 进入 prompt，并有统一注入测试
- [ ] 记忆回收与导出：message tombstone 联动 semantic/expression memory 来源删除，批量删除、recycle bin、恢复、删除审计、脱敏 JSONL 导出和 dry-run 导入
- [ ] Discord 投递不确定状态：Gateway 暴露 `delivered/rejected/unknown` 结果，Future Tasks 对 unknown 提供 reconcile，不承诺 exactly-once
- [ ] Model Operations 规格：模型能力目录、健康/延迟、成本、熔断、fallback、任务 lane、provider availability overlay 与 WebUI/审计视图统一
- [ ] DailyLife 接线：`src/admin/daily-life.ts` 当前只有规则/模型 proposal 与单测，没有接入 `WorldStore.tick()`、日程或 runtime；需要明确生成、确认、写回和失败回退语义
- [ ] Guild Plan 控制面：`DiscordGateway.applyGuildPlan()` 已有受限执行器，但 AdminServer 尚无 inventory/plan/confirmation/apply API；需补 RBAC、二次确认、审计、幂等和部分失败结果
- [ ] 配置发布持久化与激活：当前 `Runtime` 使用 `InMemoryPublicationStateStore`，重启会丢失 revision/ACK/pending/rollback；需改为 SQLite 状态、接入配置激活/组件重建，并区分“发布记录”和“实际生效配置”
- [ ] 世界/设备并发一致性：`VersionedJsonStore` 只在进程内按文件串行，`WorldStore`/`DeviceStore` 的 2 秒 cache 会造成多实例旧读；SQLite 迁移前需补跨实例冲突和 stale cache 策略
- [ ] `docs/IMMERSION.md` 规定的「角色互询」（好感≥70 + `shared` 标签 + opt-in + 内部私有通道 + 只回抽象答案）——有规格、无实现；现有 cross-chat 是管理员驱动的公开多角色对聊，不等同
- [ ] `docs/AUDIT.md`「仍需处理」中的 Medium 工程项：插件 Promise 超时强制终止（AbortSignal + 副作用生命周期令牌）、`chat_log` 保留期/容量/查询权限配置化、热重载新增/删除 Bot、全局配置变更后动态重建组件

## 当前状态
README 原路线图中的管理面、行为引擎和世界状态基础层已落地；但“完整世界模拟系统”仍是分阶段路线，当前只完成了状态、确认日程、tick 阶段和规则日计划的基础能力。上方标记为 `[ ]` 的项目是明确记录的后续工作，不代表当前发布阻塞。
