# MCP 工具权限与审计

MohoBot 内置一个最小的 MCP（Model Context Protocol, JSON-RPC 2.0）客户端层，
**默认关闭**、config 驱动、依赖零 SDK。它回答一个问题：*MCP 工具被调用时，
凭什么允许、以及谁调用过*。

## 组成

| 文件 | 职责 |
|---|---|
| `src/mcp/types.ts` | MCP 类型 + `McpTransport` seam + 类型化 `McpError` |
| `src/mcp/transport.ts` | 两个真实 transport：`StdioTransport`（子进程，换行分隔 JSON-RPC）、`HttpTransport`（`fetch` POST） |
| `src/mcp/permissions.ts` | `McpToolPolicy`：工具名（或 `prefix.*`）→ 最低角色；**未覆盖的工具一律拒绝**（fail closed） |
| `src/mcp/audit.ts` | 有界环形审计日志（默认 200 条），参数**先脱敏再落盘**（疑似密钥的键直接 `[REDACTED]`） |
| `src/mcp/client.ts` | `McpClient`：`initialize` → `tools/list` → `tools/call`；**调用先过权限门再写审计，然后才碰 transport** |
| `src/mcp/manager.ts` | `McpManager`：每个 server 一个 client，共享一份审计日志；单个 server 起不来不影响其它 |

安全要点：被拒绝的调用**永远不会到达 transport**，且无论 allowed / denied /
error 都会写入审计日志。

## 配置

在 `data/config/global.yaml` 增加（默认 `enabled: false`，不写即无行为变化）：

```yaml
mcp:
  enabled: true
  servers:
    - id: files
      transport: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/data"]
      # 凭据只走进程 env（stdio 子进程默认继承），不要把密钥写进 YAML
      policy:
        - { pattern: "read_*", minRole: viewer }
        - { pattern: "write_*", minRole: admin }
    - id: remote
      transport: http
      url: https://mcp.example.com/mcp
      headers: { "x-tenant": "mohobot" }
      policy:
        - { pattern: "search.web", minRole: viewer }
        - { pattern: "system.*", minRole: admin }
```

- `transport: stdio` 需要 `command`（+ 可选 `args`/`env`/`cwd`）；`transport: http` 需要 `url`（+ 可选 `headers`）。
- 省略 `policy` 时使用内置 `defaultPolicy`（`search.web` / `wiki.summary` / `songs.list` 允许 viewer+；`config.set` 与 `system.*` 需 admin）。
- 配置走热重载；MCP 与其它 `data/config/*.yaml` 一样支持 `*.local.yaml` 覆盖。

## 管理面（`src/admin/server.ts`，权限 + 审计）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/mcp/policy` | `mcp.read` | 内置策略规则（`pattern` / `minRole`） |
| GET | `/api/mcp/tools` | `mcp.read` | `servers`（连接状态/工具数/错误）+ 扁平化 `tools` |
| GET | `/api/mcp/audit` | `mcp.read` | 最近调用记录（已脱敏） |
| POST | `/api/mcp/call` | `mcp.call` | 调用一个工具，**需二次确认**；调用者角色取自已认证的管理主体 |

WebUI「MCP 工具」页（`mcp.read` 门控）展示策略/工具/审计；调用表单仅对
`mcp.call` 可见。角色门控见 `src/admin/rbac.ts`：`mcp.read` 自 viewer 起，
`mcp.call` 自 admin 起。

## 对话模型接入

MCP 工具已经可以作为模型工具进入回复 pipeline：`src/ai/mcp-tools.ts`
将启动后发现的工具注册到每个 Bot 的 `ChatToolRegistry`，模型调用仍统一经过
`McpManager.callTool()`，因此权限门与脱敏审计保持不变。模型调用者固定使用
最低权限 `viewer` 角色；管理员权限工具即使被模型请求也会被拒绝并记录审计。

模型工具调用仍受 `ai.tools.enabled` 总开关、allowlist 与 `maxRounds` 限制；MCP
本身默认关闭。MCP manager 会在 Bot 启动前完成初始化，确保工具 schema 已可用。
