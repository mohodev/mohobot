# MohoBot WebUI 状态与交付范围

最后核对：2026-11-14。

## 当前入口

MohoBot 现在同时保留两套管理界面，使用同一个 Admin API、Session Token、RBAC、Route Policy、确认 nonce 和审计服务：

- **经典控制台**：`/`，原生 HTML/CSS/JavaScript 单页应用，23 个既有权限门控页面。仍是功能最完整的稳定入口。
- **新控制台**：`/dashboard/`，React 19 + TypeScript + Vite 独立工程，作为逐页迁移中的新前端。由 `npm run build` 输出到 `webui/dashboard/`，不覆盖经典控制台。

管理 API 仍由 `src/admin/server.ts` 提供，默认绑定 `127.0.0.1:3210`。后端权限事实源为 `src/admin/route-policy.ts` 和 `src/admin/rbac.ts`。前端隐藏菜单/按钮只是 UX，不能替代服务端授权。

## 新控制台已迁移页面

| 页面 | 实际接入 |
|---|---|
| 登录 | 账号密码登录、旧初始化令牌交换、Session Token 复用 |
| 运行总览 | `GET /api/status`，Bot/网关/会话快照 |
| 机器人 | `GET /api/bots`、受控重启（服务端确认 nonce） |
| 模型供应商 | `GET /api/providers`、连接探测 |
| 模型运营 | `GET /api/models`、`/api/models/health`、`/api/models/dashboard` |
| 实时日志 | `GET /api/logs`、级别/关键字过滤、JSONL 导出 |
| 角色档案 | `GET /api/characters` |
| 记忆元数据 | `GET /api/memory`，不展示超出权限的原始记忆正文 |

新控制台当前使用桌面侧栏、响应式小屏布局、统一组件和加载/错误/空状态。角色编辑、完整记忆治理、MCP、插件、任务、配置发布、世界/设备等尚未迁移的功能会明确跳转至经典控制台。

## 经典控制台仍提供的功能

| 分区 | 页面与能力 |
|---|---|
| 总览 | 仪表盘、运行状态 |
| 运行 | Bot、插件、扩展、MCP、运行数据、日志、指标、健康 |
| 治理 | Operator 审计、记忆管理、知识库、用户、临时令牌 |
| 调试 | 行为 dry-run、Debug Chat |
| 配置 | 模型目录、Model Operations、Provider、配置发布、角色、世界、设备与关系 |

详细功能矩阵见本文件所在仓库的 `docs/FEATURE_MATRIX.md`。

## 明确的产品边界

- **已有 Debug Chat 不等于正式 WebChat。** 当前尚无面向终端用户的独立 WebChat Gateway、会话身份、历史工作台和流式聊天产品。
- **插件管理不等于插件市场。** 当前能管理本地插件并执行受控重载，不提供远程市场、签名、安装、升级和回滚分发服务。
- **静态资源生成不等于浏览器 E2E 已覆盖。** 新前端已有独立 TypeScript 检查和产物构建；仍需引入组件测试、Playwright 端到端门禁和初始化向导测试。

## 本地开发与构建

```bash
npm run dashboard:dev       # Vite，http://127.0.0.1:5174/dashboard/
npm run dashboard:typecheck # 前端 TypeScript 检查
npm run dashboard:build     # 构建 webui/dashboard/
npm run build               # Runtime / plugins + React Dashboard
```

## 下一步顺序

1. 完成 Dashboard 登录状态、首次部署向导和统一错误/通知体验。
2. 迁移插件、MCP、任务和配置发布页面，危险操作全部使用统一的服务端确认协议。
3. 完成正式 WebChat：独立会话模型、历史、流式传输、角色选择与附件能力。
4. 完成角色/记忆治理的编辑、审核、删除、回收站、恢复和导出流程。
5. 增加 React 组件测试与 Playwright E2E，覆盖登录、RBAC、确认 nonce、错误和移动端布局。

验收标准：每个页面必须同时具备 API 契约、权限门控、加载/空/错误状态、成功反馈和自动化测试；危险动作必须使用服务端确认与审计。只显示静态卡片或按钮不算交付。
