# MohoBot WebUI 状态与交付范围

> 本文件于 2026-10-17 按代码实况重写；早前版本严重过时。

本文件最初是对一份“所有功能已一次性写入完成”的 Markdown 清单的纠偏——那份清单没有前端应用、后端 API、鉴权或测试。此后项目在 `src/admin/` + `webui/` 真实落地了绝大部分能力，但本文件长期未更新，反而成了误导源。现状：`webui/index.html` + `assets/app.js` 是可运行的单页应用，含登录面板与 21 个按权限门控的标签页；后端是 `src/admin/server.ts`（路由/权限/风险/二次确认全部登记在 `src/admin/route-policy.ts`，角色矩阵在 `src/admin/rbac.ts`：viewer/operator/admin/developer），默认绑定 `127.0.0.1:3210`，所有请求写审计日志。

## 功能矩阵

| 功能 | 状态 | 备注 |
|---|---|---|
| 登录/配置面板 | 已实现 | `src/admin/auth-service.ts`（账号/scrypt 口令/会话/临时令牌）+ WebUI 登录面板（含本地初始化令牌模式）；密钥仍只走 env |
| 角色管理 | 已实现 | CRUD：`GET/POST /api/characters`、`GET/PUT /api/characters/:id` + `CharacterCatalog`；批量导入：`POST /api/characters/import`（校验/去重/dryRun/冲突策略）；角色页 UI 含新建/编辑/批量导入 |
| 短期记忆 | 已实现 | `GET/DELETE /api/ops/sessions`、`GET /api/ops/chat-log`、`/api/ops/discord-chat-log`；删除需二次确认并审计 |
| 中长期记忆 | 已实现 | `SemanticMemoryAdapter`（`src/memory/semantic-memory.ts`）+ `/api/memory`（列表/读取/删除，scope 隔离，删除为 dangerous 需确认） |
| 世界模拟器 | 基础已实现，完整系统进行中 | `WorldStore`（`src/admin/world.ts`）+ `/api/world`（状态/schedule/trust 确认/tick/events/day-plan）；当前仍缺 SQLite 迁移、持续事件演化、Future Task 执行、回放和多世界域隔离 |
| 行为引擎 | 已实现 | `POST /api/behavior/dry-run` + `src/admin/behavior-dry-run.ts`、`day-planner.ts`、`event-intelligence.ts` |
| 日志查看器 | 已实现 | `GET /api/logs`（level/component/after/limit 分页）+ `LogBuffer`（`src/core/log-buffer.ts`） |
| 插件管理器 | 已实现 | `GET /api/bots/:id/plugins` + `POST .../plugins/:id/reload`（`plugin.reload` 权限 + 二次确认）；WebUI「插件管理」页 |
| MCP 工具管理 | 已实现 | `src/mcp/`：client/permissions/audit + 真实 transport（stdio/http）+ `McpManager`，config 驱动（`mcp.enabled` 默认关闭，见 `docs/MCP.md`）；管理面 `GET /api/mcp/policy\|tools\|audit` + `POST /api/mcp/call`（二次确认）+ WebUI「MCP 工具」页；`src/ai/mcp-tools.ts` 已将 MCP 工具桥接进模型 pipeline，模型调用固定走 `viewer` 权限。 |
| 测试聊天 | 已实现 | `POST /api/debug/chat`（+ capabilities）经 `DebugChatFacade`（`src/admin/debug-chat.ts`）；WebUI「调试聊天」页，`debug.chat` 权限 |
| 角色互聊 | 已实现 | `src/characters/cross-chat.ts` + `POST /api/characters/cross-chat`（轮转调度、硬回合上限、重复检测、超时熔断、沙箱 system prompt）；角色页 UI 含互聊入口 |
| Bot 操作面板 | 已实现 | RBAC（`src/admin/rbac.ts`）+ 二次确认（`POST /api/confirmations`）+ 审计（`GET /api/admin/audit`）；重启 `POST /api/bots/:id/restart`（dangerous） |
| 系统状态监控 | 已实现 | `GET /api/status`（Bot 快照）、`GET /api/metrics`、`GET /api/admin/health`（healthSnapshot）；WebUI「仪表盘/服务健康/性能指标」页 |

矩阵之外已落地的门控功能（见 `webui/index.html` 导航与 `route-policy.ts`）：知识库（`/api/knowledge-bases` 全套 CRUD/搜索/绑定）、配置发布（publish/ack/rollback）、用户管理（`/api/admin/users`）、临时令牌、供应商探测、模型阵列、任务控制（`/api/tasks`）、运维审计（`/api/ops/operator-audit` + `operator-tools`）、设备与好感度（`/api/device`、`/api/affinity`）。

## 推荐交付顺序

1. **管理 API 基座** ✅ — `src/admin/server.ts`，仅绑定 localhost，强制账号/令牌鉴权，状态、Provider 健康、插件列表齐备。
2. **只读仪表盘** ✅ — 仪表盘/机器人与平台/性能指标/服务健康/模型阵列页。
3. **受控操作** ✅ — 重启 Bot、重载插件、删会话、任务暂停/恢复；RBAC + 二次确认 + 审计日志。
4. **角色域模型** ✅ — Schema/存储/API/UI + 批量导入（`POST /api/characters/import`）+ 角色互聊（`POST /api/characters/cross-chat`）均已落地。
5. **长期记忆与测试聊天** ✅ — `/api/memory` 隔离与删除审计、`/api/debug/chat` 均已交付。
6. **MCP/行为/世界模拟** — 行为 ✅；MCP ✅（`src/mcp/`：权限+审计+stdio/http transport + `McpManager`，管理面 API + WebUI 页，默认关闭、最小权限；`src/ai/mcp-tools.ts` 已桥接模型 pipeline）；世界模拟基础层 ✅，完整持续模拟仍按 `REMAINING_WORK.md` 分阶段推进。

验收标准：每个功能必须同时具备后端实现、前端交互、权限边界、错误处理和自动化测试；只有页面文字不算完成。
