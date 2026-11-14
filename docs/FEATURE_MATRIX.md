# MohoBot 功能现状矩阵

最后核对：2026-11-14
核对对象：当前重建分支代码、API 路由策略、WebUI 导航与自动化测试。
用途：这是当前功能状态的事实来源；历史审计文档保留历史上下文，不再代表当前代码状态。

状态定义：
- **已实现**：当前代码中存在实现，并有对应测试或可核对的 API/UI。
- **基础已实现**：核心流程存在，但覆盖范围、自动化、可观测性或生产恢复语义不完整。
- **未实现**：当前仓库没有对应的产品级实现。
- **平台专属**：只适用于特定消息平台，不要求所有 Adapter 都模拟相同行为。

## Runtime 与消息

| 能力 | 状态 | 当前实现 | 差距 / 后续 |
|---|---|---|---|
| Discord Gateway | 已实现 | `src/discord/`、`discord.js`、出入站投递状态与聊天日志 | 继续作为第一优先级，不能因多平台抽象而回归 |
| Console Gateway | 已实现 | `src/discord/console.ts`、离线完整管线测试 | 维持为平台无关测试入口 |
| 多 Bot Runtime | 已实现 | `src/bot/runtime.ts`、Supervisor、Bot 热重载 | 继续压测 7–8 个角色 Bot + 管理 Bot |
| 统一消息 Pipeline | 已实现 | `pipeline.ts` 编排；上下文、工具循环、回复交付、流式缓冲、限流、提示词和命令 token 已拆为独立模块 | 主编排文件仍有 1,142 行；管理命令/Persona A-B/若干策略仍可继续拆分，行为边界见 `docs/PIPELINE.md` |
| 上下文压缩 | 已实现 | Session rolling summary、Summarizer | 继续补长对话和异常恢复测试 |
| 消息编辑/删除同步 | 已实现 | MessageSync tombstone、memory deletion coordinator | 检查所有派生画像/向量记录的来源追踪 |
| 本地 WebChat 产品页 | 未实现 | 当前只有管理员 Debug Chat（`POST /api/debug/chat`） | 建立独立会话、历史、流式通信和用户身份模型 |

## 人格、关系与记忆

| 能力 | 状态 | 当前实现 | 差距 / 后续 |
|---|---|---|---|
| 角色档案 / Prompt | 已实现 | `src/characters/`、导入、版本与 CRUD API/UI | 增加版本对比、预览与回滚体验 |
| 情绪与关系阶段 | 已实现 | `src/emotion/`、AffinityStore | 观察衰减、来源解释与运营界面 |
| Persona A/B | 已实现 | `src/pipeline/persona-ab.ts` | 完善样本管理和版本化结果 |
| 角色互聊 | 已实现 | CrossChatRunner、轮次/超时/重复控制 | 继续强化预算和可追溯性 |
| Semantic Memory | 已实现 | Embedding/Rerank、scope 隔离、治理 API | 混合召回、向量后端可插拔与评测 |
| Expression Memory | 基础已实现 | 规则提取、审核、删除、回收站、导出 | 更丰富的候选生成、语境召回和审核体验 |
| Jargon / 群体黑话学习 | 基础已实现 | `src/memory/jargon-memory.ts`、群体样本、来源/共享组和候选审核 | 缺少向量召回与稳定的语境选择 |
| 记忆隐私与删除 | 已实现 | scope、provenance、tombstone 与删除 sink | 继续做跨数据域删除验收 |
| 好感度持久化 | 已实现 | `affinity:records` 写入 SQLite；旧 JSON 只读导入 | 多实例冲突通过 SQLite CAS；保留迁移源备份 |

## 模型、工具与插件

| 能力 | 状态 | 当前实现 | 差距 / 后续 |
|---|---|---|---|
| OpenAI-compatible Provider | 已实现 | `src/ai/openai-compatible.ts`、Provider registry | 原生协议适配器可按真实需求增加 |
| 多模型路由 / fallback | 已实现 | MultiProviderRouter、task lane、circuit breaker | 增加可解释的路由 trace 与基准评测 |
| Model Catalog / Health / Usage | 已实现 | `src/ai/`、model-catalog 插件、Model Operations | Provider 配置体验和自动化回归继续完善 |
| OpenCode CLI | 已实现 | `src/ai/opencode-cli.ts` | 明确 CLI Agent / Provider / ACP 的契约边界 |
| LLM Tool Calling | 已实现 | ChatToolRegistry、有界轮次和 allowlist | 扩展工具结果审计、超时与取消 |
| MCP | 已实现 | stdio/HTTP transport、权限、审计、viewer bridge；默认关闭；经典与 React Dashboard 均有策略/Server/工具/脱敏审计视图，调用受 `mcp.call` RBAC + nonce + MCP tool policy 约束 | 新 UI 仍需补更多异常状态和 schema 表单体验 |
| ACP | 已实现 | `src/acp/` | 兼容性和恢复/取消行为继续完善 |
| Operator Agent | 已实现 | 受控诊断/写操作暂存/确认，独立权限平面 | 增加工具执行 trace UI 和更细能力范围 |
| 本地插件 | 已实现 | `plugins/<id>/plugin.json`、热加载、生命周期回收 | SDK 文档、manifest schema、兼容性契约 |
| 扩展注册表 | 已实现 | Provider/Gateway/Storage/Memory 四类 registry | 更多适配器契约测试 |
| 插件市场/远程安装升级 | 未实现 | 当前没有完整市场和分发服务 | 需要签名/来源/版本/权限/依赖/回滚设计，不能直接执行任意下载代码 |

## 平台与消息能力

| 能力 | 状态 | 当前实现 | 差距 / 后续 |
|---|---|---|---|
| Discord 原生交互 | 已实现 | Mention、DM、Thread/Forum、Slash/受限管理入口 | 优先保证现有行为不变 |
| Platform Adapter Contract | 基础已实现 | `src/platform/types.ts`、open platform ID、runtime-scoped gateway registry、可选 guild capability | 仍需入站归一化 SDK、能力清单和真实 OneBot/QQ/WebChat adapter |
| Console | 已实现 | 纯文本终端入口 | 保留自动化验收用途 |
| OneBot v11 / QQ | 未实现 | 参考仓库中有 Python 实现，不属于当前项目 | 先做 Platform Adapter contract，再单独评估实现 |
| WebChat 平台 Adapter | 未实现 | 管理 API 的 Debug Chat 不等同于聊天 Gateway | 以统一消息 envelope 设计正式 WebChat |
| TTS / 语音通道 | 未实现 | 当前媒体能力以附件/视觉/OCR/VLM 为主 | 明确平台、后端和资源开销后再实施 |

## 自动化与沉浸状态

| 能力 | 状态 | 当前实现 | 差距 / 后续 |
|---|---|---|---|
| World 状态机 | 已实现 | SQLite、事件来源链、信任/确认、phase、trace、replay、domain；读无本地缓存，写使用 CAS/retry | 后续压测高并发 tick 与 schedule 的重试公平性 |
| Device 状态 | 已实现 | SQLite、设备状态与习惯；读取直达 DB，transition 使用 CAS/retry，显式 save 拒绝 stale snapshot | 后续压测高并发 transition 与历史 JSON 导入冲突 |
| DailyLife | 基础已实现 | 规则回退与 World tick 接线 | 增强跨天一致性、任务取消和异常恢复 |
| Talk Governor | 基础已实现 | Quiet hours、topic relevance、focus lease、SQLite state | 主动消息队列和 Future Task 出站二次治理 |
| Future Tasks | 基础已实现 | SQLite、CAS claim、lease recovery、retry/uncertain、受限 handler | 扩展 handler 必须先做安全白名单和 owner scope |
| Discord 投递对账 | 已实现 | delivered/rejected/unknown、outbox、reconcile | 不承诺 exactly-once，继续做崩溃窗口测试 |

## Admin API 与 WebUI

| 能力 | 状态 | 当前实现 | 差距 / 后续 |
|---|---|---|---|
| Admin Auth / Setup | 已实现 | 首次部署、账号/口令、会话、临时令牌 | 增加登录限流与 E2E |
| RBAC / Route Policy | 已实现 | `src/admin/rbac.ts`、`route-policy.ts`、审计、确认 nonce | 建立从路由到前端权限的自动契约校验 |
| Admin API | 已实现 | `server.ts` 统一处理 HTTP/auth/RBAC/Route Policy/nonce/audit；`api-router.ts` 协调；`api-routes/` 按 Models/Ops/Config-Users/Characters-MCP/Memory/Knowledge/World 拆分 | 后续输出 OpenAPI、生成 TypeScript client、补 response schema contract |
| 经典管理 WebUI | 已实现 | 原生 HTML/CSS/JS，23 个权限门控导航页，保留于 `/` | 继续作为完整回退入口；前端单体约 66 KB，后续逐页迁移后再退役 |
| Debug Chat | 已实现 | 单次模型调试、权限门控 | 不能当作面向用户的本地聊天产品 |
| Model Operations UI | 已实现 | 模型健康、用量、fallback/circuit 事件等 | 增加筛选、时间区间和路由解释 |
| 插件管理 UI | 已实现 | 经典 UI 与 React Dashboard 均显示按 Bot 分组的本地插件状态；重载由 `plugin.reload` + nonce + 审计保护 | 新 UI 仍需迁移插件配置表单；缺远程市场、签名、安装、升级和回滚 |
| WebUI 新前端 | 已实现 | `dashboard/`：React 19 + TypeScript + Vite；复用现有 Session Token、Admin API 与 RBAC；21 个权限门控页面（总览、Bot、Provider、模型、日志、角色、语义记忆、表达/黑话、知识库、世界、设备、好感度、任务、Future Tasks、插件、MCP、会话审计、管理员、配置发布、服务健康、调试）；共享 `lib/`（types/hooks/format/api）+ `components/ui` 契约 + jsdom 组件测试；含首次部署向导；视觉层重写为与经典控制台一致的 AstrBot 风格 Material 3 设计系统（浅色优先、主色 `#3C96CA`、`--md-*` token、`prefers-color-scheme` + `[data-theme="dark"]` 深色），21 个页面组件零改动 | 补浏览器 E2E、OpenAPI 生成的类型化 client 与页面级 response schema；经典控制台继续作为回退入口 |
| 生成式 API Client | 未实现 | 前端请求路径手写 | 先由 Admin API 输出 OpenAPI，再生成 TS client |
| 浏览器 E2E | 未实现 | 主要是 API/contract/单元测试 + Dashboard jsdom 组件测试 | Playwright 覆盖登录、配置、聊天、角色、插件和危险确认 |

## 非功能要求（重建期间不得退化）

1. 默认单进程轻量运行；不要为模块边界而引入微服务。
2. SQLite 是内置持久化真相源；旧 JSON 只允许作为只读迁移输入，不得新增写路径。
3. 角色聊天面与 Operator/Admin 控制面严格隔离；模型工具使用最小 capability。
4. 高风险操作保留二次确认和审计；插件是进程内可信代码，不得宣称为安全沙箱。
5. Discord 行为和现有配置/数据库必须保持兼容；所有数据迁移都可预检、备份和回滚。
6. “已实现”必须同时满足实现、权限、持久化、异常处理和测试，不以页面文字或 TODO 完成为依据。

## 当前质量基线

2026-11-14 在 Node.js v24.21.0 下，依赖安装后曾验证：
- TypeScript typecheck 通过；
- 后端 166 个 Vitest 文件、1,153 个测试通过；
- React Dashboard 2 个测试文件、8 个用例通过；
- React Dashboard 独立 TypeScript 检查通过；
- SQLite preflight 通过；
- secret scan 未发现密钥；
- build 通过。

后续重构必须以重建分支最新一次完整验证结果更新此处，不将历史数字作为永久保证。
