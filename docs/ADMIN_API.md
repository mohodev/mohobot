# Admin API module boundaries

核对日期：2026-11-14。

## Request pipeline

所有管理 API 请求必须按以下顺序执行：

1. AdminServer 处理未初始化时的 Bootstrap、登录、Setup 状态和静态资源路由。
2. 提取 Session Token 并完成认证；未认证请求记录拒绝审计。
3. 通过 routePolicy(method, pathname) 查找领域权限、风险级别和是否需要二次确认；没有 policy 的路由拒绝执行。
4. 使用 RBAC 检查 principal 权限。
5. 对高风险操作校验/消费服务端确认 nonce。
6. 调用 AdminApiRouter 将请求分派至领域 handler。
7. 对允许/拒绝结果写入审计；异常按已知 HttpError 状态映射，其余异常做安全 500 响应。

**领域 handler 不负责认证、RBAC、确认 nonce 或审计入口。** 不允许为了方便在 handler 内加绕过 Route Policy 的独立 API。

## Modules

| Module | Responsibility |
|---|---|
| src/admin/server.ts | HTTP listener、Bootstrap/Login、认证、Route Policy、RBAC、nonce、审计、静态资源 |
| src/admin/api-router.ts | 组装 Router Context、传递 request context、按顺序委派领域 handler |
| api-routes/models.ts | Provider、Model Catalog/Health/Operations、Bot、Gateway 和本地插件重载 |
| api-routes/ops.ts | 管理动作、系统健康、Runtime metrics、结构化日志、会话/聊天记录、Operator 工具审计 |
| api-routes/config-users.ts | 配置发布、ACK/rollback/activation receipt、管理员账号 CRUD |
| api-routes/characters-mcp.ts | 角色 CRUD/import/cross-chat、MCP policy/tools/audit/call |
| api-routes/memory.ts | Semantic/Expression/Jargon memory 管理、审核、回收站、恢复、导出/导入 dry-run |
| api-routes/knowledge.ts | Knowledge Base、文档、搜索与绑定 |
| api-routes/world.ts | World、Future Tasks、Outbox reconcile、Device/Affinity、Guild plan |
| api-routes/helpers.ts | 无状态 query 参数解析与 Ops service guard |
| api-types.ts / api-errors.ts | ApiResult 与带 HTTP 状态的内部错误类型 |

## Compatibility and invariants

- API path、HTTP method、response body、RBAC permission string、Route Policy risk/confirmation 定义在此次抽取中不改变。
- 业务 service 仍通过依赖注入传入；Router 不创建第二套 auth、storage 或 audit 实例。
- 静态资源和 React Dashboard 路径继续由 AdminServer 提供。
- 领域 handler 返回 undefined 表示未匹配，让后续 handler/404 继续处理；匹配的 handler 返回 ApiResult 或抛 HttpError。
- 新增 endpoint 必须同步增加 Route Policy、RBAC/permission test、AdminServer integration test、相应领域 handler 和 WebUI 状态。
- 不要让前端菜单隐藏取代服务端授权；不要在 handler 里信任前端传入的 principal/role。

## Verification

当前 AdminServer 集成测试覆盖登录/会话、RBAC、Route Policy、二次确认、审计、角色、MCP、记忆、知识库、World/Device、Guild 和任务管理。根 npm test 运行所有后端与 Dashboard 测试。
