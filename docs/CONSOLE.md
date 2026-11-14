# MohoBot 控制台状态与交付范围

最后核对：2026-11-14。

## 当前入口

MohoBot 现在只有一套管理界面：**React 控制中心**，位于 `/`。

- **React 控制中心**：`/`，React 19 + TypeScript + Vite 独立工程（`dashboard/`），21 个权限门控页面。
- 旧的原生经典控制台（`webui/index.html` + `webui/assets/*`）已删除；React 版接管根路径。
- `/dashboard/` 作为别名保留，指向同一个 React 应用，以免旧书签失效。
- 构建由 `npm run build` 输出到 `webui/index.html` 与 `webui/assets/`（`webui/` 整体为生成产物，已加入 `.gitignore`）。

管理 API 仍由 `src/admin/server.ts` 提供，默认绑定 `127.0.0.1:3210`。后端权限事实源为 `src/admin/route-policy.ts` 和 `src/admin/rbac.ts`。前端隐藏菜单/按钮只是 UX，不能替代服务端授权。

## 已接入的 API

前端只通过 `dashboard/src/lib/api.ts` 的 `api()` / `confirmedRequest()` 访问后端，保证 Session Token、RBAC、确认 nonce 与审计链路一致。契约由 `src/admin/webui-contract.test.ts` 守护（确认重放负载、令牌仅存于内存/sessionStorage、写入负载字段、中文确认短语）。

## 页面与主接口

| 页面 | 主要接口 |
|---|---|
| 登录 / 初始化 | `/api/setup/status`、`/api/setup/init`、`/api/auth/login`、`/api/auth/session`、`/api/auth/me` |
| 运行总览 | `GET /api/status`、`GET /api/admin/health`、`GET /api/metrics` |
| 机器人 | `GET /api/bots`、`GET /api/bots/:id/gateway`、`POST /api/bots/:id/restart` |
| 模型供应商 | `GET /api/providers`、`POST /api/providers/:id/probe` |
| 模型运营 | `GET /api/models`、`/api/models/dashboard`、`/api/models/health`、`/api/models/usage/:id` |
| 角色档案 | `GET/POST/PUT /api/characters`、`POST /api/characters/import`、`/api/characters/cross-chat` |
| 语义记忆 | `GET /api/memory`、`/api/memory/:id`、`/api/memory/semantic/*` |
| 表达与黑话 | `GET /api/memory/jargon`、`/api/memory/expressions` 及审核接口 |
| 知识库 | `/api/knowledge-bases` 及其 documents/bindings/search 子资源 |
| 世界模拟 | `GET /api/world`、`/api/world/schedule`、`/api/world/trace`、`POST /api/world/tick`、`/api/world/events` |
| 设备状态 | `GET /api/device`、`POST /api/device/transition` |
| 好感度 | `GET /api/affinity`、`POST /api/affinity/adjust` |
| 任务调度 | `GET /api/tasks`、`POST /api/tasks/:id/(pause|resume|run)` |
| Future Tasks | `GET /api/tasks/future`、`POST /api/tasks/future/schedule`、`/reconcile` |
| 插件管理 | `GET /api/bots/:id/plugins`、`POST /api/bots/:id/plugins/:id/reload` |
| MCP 工具 | `GET /api/mcp/policy`、`/api/mcp/tools`、`/api/mcp/audit`、`POST /api/mcp/call` |
| 实时日志 | `GET /api/logs` |
| 服务健康 | `GET /api/admin/health`、`/api/metrics`、`/api/status` |
| 会话与审计 | `GET /api/auth/sessions`、`/api/ops/sessions`、`/api/ops/chat-log`、`/api/admin/audit`、`/api/ops/operator-audit` |
| 管理员 | `GET/POST/PATCH /api/admin/users`、`/api/auth/temporary-tokens` |
| 配置发布 | `GET /api/config/publication`、`POST /api/config/publish`、`/ack`、`/rollback` |
| 调试工作台 | `GET /api/debug/chat/capabilities`、`POST /api/debug/chat`、`/api/behavior/dry-run` |
