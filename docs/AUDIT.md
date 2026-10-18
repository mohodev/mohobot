# MohoBot 代码审计（2026-08-13）

## 已验证基线

- `npm run typecheck`：通过
- `npm test`：153/153 通过
- `npm run build`：通过

## 本轮已修复

### Critical

- 从当前工作树移除 `config/global.yaml` 中疑似真实 Kilo Token。
  - ~~外部动作：在 Kilo 后台吊销/轮换~~ → **2026-10-17 决策：Kilo 账号不可用，凭据无法吊销；按失效凭据处理，接受残留风险（见下方「2026-10 复查」决策记录）。** 普通 Git 删除本就无法清除历史。

### High

- 插件 ID 拒绝 `..`、绝对/嵌套路径。
- 插件 `main` 入口限制在插件目录内，并检查符号链接真实路径。
- 修复 `plugin.json.config` 被解析后丢弃的问题。
- 插件 `onLoad` 失败时回收 staged 命令和四类 Registry 注册，避免幽灵扩展泄漏。
- `devtools` 默认关闭；其 AI 压测、注入和跨频道发言能力不应直接暴露给普通用户。

### Correctness / reliability

- 同一会话消息按到达顺序串行执行，防止 AI 回复乱序写入历史。
- 会话持久化写入串行化，防止较慢旧快照覆盖新快照。
- Discord/Console 入站聊天日志统一在 Gateway 写入，消除 Discord 双写。
- Discord 只记录通过 blocked/allowlist/mention/DM 过滤并进入管线的消息。
- 未知 Provider 不再在 credential 检查阶段抛错，而是按文档回退。
- Provider 单次调用的 timeout override 会显示正确超时值。
- 修复 Provider 配置优先级：`global.yaml` 覆盖 `data/provider.yaml`。
- `data/provider.yaml` 变更可被热重载识别。
- NPM 包恢复 `private: true`，避免误发布。

## 仍需处理

### High

- 对管理类插件命令实现统一权限模型（管理员用户/角色 allowlist、频道限制、命令级限流）。仅默认关闭 devtools 不是最终权限方案。
- ~~清理 Git 历史、CI Artifact、镜像和备份中的泄露 Token~~ → 2026-10-17 决策：不再要求（凭据无法吊销，见下方决策记录）；如需清历史属可选加固。

### Medium

- 插件 Promise 超时只能停止等待，无法强制终止 JS 任务；需要 `AbortSignal` 与副作用生命周期令牌。
- `chat_log` 需要配置化保留周期、容量上限、用户删除与查询权限。
- Runtime 热重载只重启已存在 Bot；新增/删除 Bot 仍要求进程重启。
- 全局配置（存储、日志级别、Supervisor、监听路径）改变后未动态重建相关组件。
- ~~管理 WebUI、角色、世界模拟、行为引擎、MCP、真实长期记忆仍未实现~~ → **2026-10-17 更新：已实现**。管理 WebUI（`src/admin/server.ts` + `webui/`，RBAC + 二次确认 + 审计）、角色 CRUD/批量导入/互聊（`src/characters/`）、世界模拟（`src/admin/world.ts`）、行为引擎（`behavior-dry-run.ts`/`day-planner.ts`/`event-intelligence.ts`）、可检索长期记忆（`src/memory/semantic-memory.ts`）、MCP 权限+审计+transport + 模型工具桥接（`src/mcp/` + `src/ai/mcp-tools.ts`，默认关闭，config 驱动）均已落地。模型调用固定使用低权限 `viewer` 角色，并继续经过 MCP 权限门与审计。

## 安全原则

- 密钥只进入环境变量或专用 secret manager，不进入 YAML、注释、日志、截图或测试 fixture。
- 管理能力默认关闭；启用时最小权限、显式 allowlist、完整审计。
- 插件视为进程内受信代码，不是安全沙箱；安装插件等同执行代码。

## 2026-10 复查：Secret scanning

已加入 `npm run scan-secrets`（扫描被跟踪文件）与 `npm run scan-secrets -- --history`（扫描每个提交新增的行）。输出一律脱敏（仅前 4 个字符 + 长度），发现即退出码 1；同一行加 `secretscan:ignore` 可抑制已确认的误报。`npm test` 内含一条守卫测试，保证**被跟踪文件**不再含凭据形状的值（因此 `npm run update` 流程也会拦截）。

首次扫描的结果（以代码为准，数值已脱敏）：

| 位置 | 提交 | 状态 |
|---|---|---|
| `data/config.example.json:42`（kilo provider 的 `key`，JWT 形状） | `6f3cba0` | **已从工作树移除**，改为占位符；历史中仍存在 |
| `config/global.yaml:17`（注释里的 `MOHO…=` JWT 形状令牌） | `ed70466` | 工作树早已移除；历史中仍存在 |

**2026-10-17 决策记录（替代原「仍需所有者完成」待办）：**

Kilo 侧账号不可用，上述凭据**无法吊销/轮换**。项目决策：将其视为已失效凭据，接受历史残留风险，不再跟进轮换与强制清史。理由与边界：

1. 凭据无法通过任何渠道重新生效（吊销入口不存在），维持「必须吊销」的警告没有可执行动作。
2. 如需彻底清除历史，仍可选做 `git filter-repo` + 强制推送（破坏性，需全员重新克隆）——属加固而非必须。
3. `npm run scan-secrets -- --history` 会持续报告上述两条历史命中，这是**已知且接受**的；`npm test` 的守卫仍保证被跟踪文件不再含凭据形状的值。

另外：上级目录 `/workspaces/264638881` 的 `.gitignore` 显式放行 `*.txt`，会让放在那里的凭据文件（如 `key.txt`）变成可被 `git add -A` 提交的未跟踪文件；已在该 `.gitignore` 末尾追加 `key.txt`。
