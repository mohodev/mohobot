# 遗留清单（2026-10-17 更新）

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
- [ ] 把 MCP 工具作为**模型可调用工具**接入回复 pipeline（现在仅管理员经 WebUI/API 显式调用；需要新的 pipeline 阶段）
- [ ] `docs/IMMERSION.md` 规定的「角色互询」（好感≥70 + `shared` 标签 + opt-in + 内部私有通道 + 只回抽象答案）——有规格、无实现；现有 cross-chat 是管理员驱动的公开多角色对聊，不等同
- [ ] `docs/AUDIT.md`「仍需处理」中的 Medium 工程项：插件 Promise 超时强制终止（AbortSignal + 副作用生命周期令牌）、`chat_log` 保留期/容量/查询权限配置化、热重载新增/删除 Bot、全局配置变更后动态重建组件

## 当前无遗留计划项
README「路线图」六阶段均已落地（对应实现见上）。以上「剩余」为明确评估过的可选增强，不是待办阻塞项。
