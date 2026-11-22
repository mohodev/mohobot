# MohoBot Admin API — OpenAPI 标准

定稿日期：2026-11-22。核对对象：`src/admin/route-policy.ts`、`src/admin/server.ts`、
`src/admin/api-router.ts`、`src/admin/rbac.ts`、`docs/ADMIN_API.md`。

这份文档是标准本身，不是愿望清单：**规范描述现实，不发明接口**。
任何与代码不一致的 spec 条目都是 bug，修 spec 或者修代码，二选一，不许将错就错。

## 1. 盘点结果（已核对，不是估计）

- Route Policy 条目：**107 条**（`ROUTE_POLICIES`，不含接口定义和 `routePolicy()` 函数本身）。
- 其中 3 条 policy 展开为多个操作：
  - `GET /api/world(?:/day-plan)?` → `GET /api/world`、`GET /api/world/day-plan`
  - `POST /api/world/(tick|events)` → `POST /api/world/tick`、`POST /api/world/events`
  - `POST /api/tasks/{id}/(pause|resume|run)` → pause / resume / run 三个操作
- Policy 展开后：**111 个操作**。方法分布：GET 58、POST 44、DELETE 7、PATCH 1、PUT 1。
- 风险分布：read 62、impact 28、dangerous 11、reversible 10；需要二次确认的操作：**39 个**。
- 不在 Route Policy 里、但在 `server.ts` 里前置处理的认证/初始化操作：**5 个**：
  `POST /api/auth/bootstrap/session`、`POST /api/auth/session`、
  `POST /api/auth/login`、`GET /api/setup/status`、`POST /api/setup/init`。
- **OpenAPI 操作总数：116 个。**之前说的“79 个接口”是按字面量路径去重后的数字，
  漏掉了带路径参数的操作，作废，以 116 为准。
- 明确不在 spec 里：`/api/ops/outbox`、`/api/remote/health`、`/api/not-in-policy` 等——
  它们在测试里被断言为 403（无 policy 即拒绝），不是接口。
- 3 个 policy 操作没有专属 RBAC permission，但仍需登录会话：
  `GET /api/auth/me`、`POST /api/auth/logout`、`POST /api/confirmations`。

## 2. 版本与文件

- OpenAPI 版本：**3.0.3**。不用 3.1：3.0 的 TypeScript 客户端生成器兼容性最广
  （`openapi-typescript` 等），且与仓库已有的 `yaml` 依赖、无框架的 Node 服务最贴合。
- 文档版本：`info.version: 1.0.0`，对应第一版完整 spec；后续见第 9 节。
- 规范唯一来源：**`docs/openapi.yaml`**（YAML，手写、可读、入版本库）。
- 运行时出口：**`GET /api/openapi.json`**，返回同一份文档转成的 JSON。
  该出口本身**不列入 spec 的 operations**（它是元数据出口，列进去会自指），
  见第 3 节的实现方式。
- 不引入新依赖：解析 YAML 用仓库已有的 `yaml`（`package.json` 已有 `^2.6.1`）；
  不引入 swagger-ui、openapi 校验库等新运行时依赖。

## 3. 服务端挂出方式

- `GET /api/openapi.json` 在 `server.ts` 里像 `login` / `setup/status` 一样前置处理，
  **在 Route Policy 查找之前**，但**在认证之后**：
  - 未带有效 Session Token → 401 `{ok:false, error:"unauthorized"}`，与其它接口一致。
  - 任何已登录角色（viewer 起）都可读，不设专属 permission，不进 `ROUTE_POLICIES`
    （加 policy 会让 spec 的操作数自指，契约测试无法收敛）。
  - 读取 `<rootDir>/docs/openapi.yaml`，用 `yaml` 解析后以 JSON 返回；
    文件缺失或解析失败 → 500（服务端问题，不伪装成 404）。
  - 响应头与其它 JSON 接口一致（`securityHeaders()`，`content-type: application/json`）。
- 不做缓存失效的复杂设计：每次请求现读现解析，Admin 服务是单进程低频管理面，
  spec 文件只在发版时变。

## 4. 认证

- 默认 security：`BearerAuth`，即 `Authorization: Bearer <session token>`。
  Session Token 来源：`POST /api/auth/login`（用户名+口令）或
  `POST /api/auth/session` / `POST /api/auth/bootstrap/session`
  （部署主密钥经 `X-Admin-Token` 头交换，见下）。
- 5 个前置操作标记 `security: []`（无需会话）：
  - `POST /api/auth/login`：body `{username, password}`。
  - `POST /api/auth/session` 与 `POST /api/auth/bootstrap/session`：
    主密钥放 `X-Admin-Token` 头（`Authorization: Bearer` 也接受，见 `server.ts`），
    两个路径是历史别名，行为一致，都要写进 spec。
  - `GET /api/setup/status`：公开查询初始化状态。
  - `POST /api/setup/init`：首次部署初始化，成功后返回 `masterToken`（仅显示一次）。
- 其余 111 个操作默认 `BearerAuth`，不再逐个重复写 security。
- 没有 API Key、没有 OAuth、没有其它认证方式，不许在 spec 里发明。

## 5. 请求与响应信封（照抄 server.ts，不许美化）

- 成功：HTTP 200（创建类操作按代码返回 201，例如临时令牌、确认 nonce、
  登录/bootstrap/setup），body 一律是 JSON 对象，且含 `ok: true`，
  其余字段按操作展开。成功 body 永远不是数组、不是裸值。
- 失败：body 一律 `{ok: false, error: "<string>"}`，`error` 是英文短码或短句
  （例如 `unauthorized`、`forbidden`、`confirmation required`、具体的 HttpError message）。
- 请求体规则（`server.ts#readBody`）：只接受 JSON 对象；空 body 视为 `{}`；
  非对象/数组、非法 JSON、超过 1 MB → 400。
- 状态码只写代码里实际能返回的：
  - 400：参数/JSON/业务校验失败（`HttpError(400, …)` 及 `#mapError` 的兜底映射，
    注意：未知异常在 AdminServer 里被映射为 400，不是 500）。
  - 401：未认证（缺/无效 Session Token、主密钥错误、登录失败；账号锁定是 409）。
  - 403：无 policy、无权限、或被禁用的账号。
  - 404：资源不存在（bot / 会话 / 令牌 / 角色 / 知识库等按 handler 而定）。
  - 409：需要二次确认、确认 nonce 无效、资源冲突、服务不可用
    （例如某 facade 未配置时抛的 `HttpError(409, …)`）、账号锁定。
  - 429：仅 Debug Chat 限流等明确抛出的场景才写。
  - 502：仅 MCP / Debug Chat 等明确返回 502 的场景才写。
  - 500：spec 出口自身读不到文件时；业务 handler 不承诺 500（兜底是 400）。
- 每个操作只列它实际能返回的状态码，不许把 401/403/404/409 全套复制到每个操作上。

## 6. 二次确认（高风险操作的硬性规则）

- `confirmation: true` 的操作（39 个）必须带请求头 `X-Admin-Confirmation: <nonce>`，
  否则 409 `{ok:false, error:"confirmation required"}`。
- nonce 来源：先调 `POST /api/confirmations`，body
  `{method, path, body}`，返回 201 `{ok:true, confirmation:{nonce,…}, target:{…}}`；
  nonce 一次性，服务端按 principal + permission + action + payload 校验并消费。
- spec 里每个需确认的操作用扩展字段标明，不用文字描述代替机器可读标记：
  ```yaml
  x-moho-confirmation: true
  x-moho-permission: users.credentials.rotate
  x-moho-risk: dangerous
  x-moho-action: users.password.rotate
  ```
- 不需确认的操作也标 `x-moho-risk` / `x-moho-permission` / `x-moho-action`
  （无 permission 的 3 个操作标 `x-moho-permission: null`），
  让生成器和前端能直接读，不用再解析文字。

## 7. 命名与结构

- 路径：**不改现有路径，不加 `/v1` 前缀**。`docs/ADMIN_API.md` 的兼容性不变量：
  API path、HTTP method、response body、RBAC permission string、
  Route Policy risk/confirmation 定义不因出 spec 而改变。
- `operationId`：默认用 Route Policy 的 `action`（例如 `models.read`、`users.password.rotate`）。
  一个 policy 展开成多个操作的 3 处，加后缀消歧：
  `world.read.day-plan`、`world.write.tick`、`world.write.events`、
  `tasks.control.pause`、`tasks.control.resume`、`tasks.control.run`。
  `operationId` 全局唯一，契约测试强制检查。
- `tags` 按领域分：Auth、Setup、Status、Bots、Models、Providers、Memory、
  Knowledge、World、Device、Affinity、Tasks、Characters、MCP、Config、Admin、Ops、Guild、Debug。
- 路径参数用描述性名字，不用 `{id}` 一刀切：
  `/api/bots/{botId}`、`/api/characters/{characterId}`、
  `/api/knowledge-bases/{knowledgeBaseId}/documents/{documentId}`、
  `/api/models/usage/{botId}`、`/api/models/health/{providerId}`、
  `/api/auth/sessions/{sessionId}`、`/api/auth/temporary-tokens/{tokenId}`、
  `/api/admin/users/{userId}`、`/api/tasks/{taskId}`、
  `/api/memory/{memoryKey}`、`/api/ops/sessions/{sessionKey}` 等。
- 查询参数按操作逐个写，不发明全局分页：
  - 多 Bot 场景通用的 `botId` 查询参数只在 handler 实际读取它的操作上出现。
  - 已有分页/游标语义照抄代码：`GET /api/logs` 是 `after` + `limit`（1–500）；
    `GET /api/social/disclosure-audit` 是 `limit`（默认 50，1–200）；
    其它列表接口有 `limit` 的按各自 handler 的实际取值写，没有的不要补。
  - 新增接口（以后）默认用 `limit`（默认 50，上限 200）+ `after` 游标，
    不用 `offset`（`offset` 只在审计查询的测试数据里出现，不是接口约定）。
- 时间一律 RFC 3339 / ISO 8601 字符串（`format: date-time`），例如 `GET /api/status` 的 `now`。
- Schema 诚实原则：只写在 handler 或测试里核实过的字段；
  复杂领域对象暂未逐字段核实的，用 `type: object` + `additionalProperties: true`
  并加 `description` 说明“字段以实现为准”，不许凭空编字段。
  每个成功响应都含 `ok: true`（`required: [ok]`，`enum: [true]`）。

## 8. 契约测试（spec 落地才算数）

新增测试 `src/admin/openapi-contract.test.ts`（后端 Vitest 套件内），至少断言：

1. `docs/openapi.yaml` 能被 `yaml` 解析，且 `openapi` 字段为 `3.0.3`。
2. 操作集合与代码一致：每个 `ROUTE_POLICIES` 条目展开后（第 1 节的 3 条展开规则）
   都在 spec 里有对应 method + path；5 个前置操作也在；spec 里没有多余操作。
   （`/api/openapi.json` 本身除外，见第 3 节。）
3. 每个操作的 `x-moho-permission` / `x-moho-risk` / `x-moho-action` /
   `x-moho-confirmation` 与 `routePolicy()` 返回值一致。
4. `operationId` 全局唯一；所有 `$ref` 能解析；所有 path 参数都在 `parameters` 里声明。
5. 服务端测试：已登录请求 `GET /api/openapi.json` 返回 200，内容与
   `docs/openapi.yaml` 解析结果一致；未登录请求返回 401。
6. 危险操作（`risk: dangerous`）必有 `confirmation: true`（与现有
   `route-policy.test.ts` 的规则一致，spec 侧再查一遍）。

`ADMIN_API.md` 的既有规则继续有效：新增 endpoint 必须同步加 Route Policy、
RBAC/permission test、AdminServer integration test、领域 handler 和 WebUI 状态——
现在再加一条：**同步更新 `docs/openapi.yaml`，契约测试会拦住漏掉的人。**

## 9. 版本管理

- Admin API 路径本身不带版本，`info.version` 是 spec 文档的版本，不是 URL 版本。
- 不兼容变更（改路径、改方法、删字段、改必填、改 permission/risk/confirmation）
  必须：spec 主版本号 +1，并在 `docs/OPENAPI.md` 的“变更记录”里写明影响，
  同时更新 `docs/FEATURE_MATRIX.md` 和 `docs/ADMIN_API.md` 的核对日期。
- 兼容变更（加操作、加可选字段、加 tag/description）只升 minor/patch，
  不需要迁移说明。
- 客户端生成（TypeScript client）是下一步，不属于本标准：
  spec 落地并通过契约测试后，再选生成器（首选 `openapi-typescript`），
  生成物放 `dashboard/src/lib/api-generated.ts`（待定，生成时再确认），
  手写 `dashboard/src/lib/api.ts` 在生成 client 接管前保持不动。

## 10. 分工（本标准之后的三步）

1. 写 `docs/openapi.yaml`：116 个操作全量覆盖，先骨架（路径/方法/参数/permission/
   risk/confirmation/响应状态码），再补逐个 response/request schema。
2. 服务端挂出 `GET /api/openapi.json` + 写 `openapi-contract.test.ts`。
3. 按 AGENTS.md 的验证顺序跑：`typecheck` →  focused tests → `npm test` →
   `scan-secrets` → `preflight` → `build`；更新 `FEATURE_MATRIX.md`；
   以 `carefreesongs712 <carefreesongs@163.com>` 身份提交，**不签名**
   （该仓库本地 git 配置已如此设置）。

## 变更记录

- 2026-11-22：初版。盘点 107 条 policy → 116 个操作；定 OpenAPI 3.0.3、
  `docs/openapi.yaml` + `GET /api/openapi.json`、Bearer 会话认证、
  `{ok:true/false}` 信封、二次确认扩展字段、契约测试规则。
