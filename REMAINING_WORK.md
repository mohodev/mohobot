# 遗留清单（2026-10-11 更新）

## 全部完成 ✅
- [x] 终极闭环（2026-10-11 用户确认）：在 Discord 群里 @墨染荷韵 说话，`GET /api/ops/discord-chat-log` 出现 in+out 记录
- [x] 管理端 Discord 入站/出站聊天日志：GET /api/ops/discord-chat-log（权限 chats.log.read，operator+，内存环形500条不落盘，summary≤500字符scrub）— 已上线实测
- [x] 端到端验证：console 全链路真实进程冒烟通过（入站落库→kilo/hy3非fallback回复→出站落库→人设文本，19.1s）；生产实例 debug-chat 冒烟 4.2s ok
- [x] 上游对比：见 UPSTREAM_COMPARE.md — 结论不变：同名不同种(QQ/Python vs Discord/TS)，不迁移 Python；10 月又跟随了上游数据源与运营功能（emotion / persona_ab / usage_stats / music_knowledge / 搜索），QQ 特有能力除外
- [x] 10 月功能批（已 push）：好感度与关系阶段（`src/emotion/`）、人设 A/B（`src/pipeline/persona-ab.ts`）、用量统计与会话排行（`?用量` / `?用量 会话`）、VCPedia 歌曲库（`src/songs/` + `?同步歌曲`）、三后端搜索（`plugins/search`）、趣味与迎新插件（`plugins/fun` / `welcome` / `bilibili`）、两步广播（`?广播`）、ban 与 repeat-guard、opencode-cli + ACP、SQLite-only、`data/` 单卷、滚动上下文摘要、secret 扫描
- [x] peer-bot summon 修复（已 push）：`discord.peerBots` 成员 @/DM 视同人类 direct summon end-to-end（adapter→pipeline gate→social decision→interrupt→model-plan override），含 4 个测试
- [x] MCP 基础设施（本地）：`qcfr`（Discord 读写桥）+ `jev`（System One 决策模型）注册到 `~/.config/opencode/opencode.json`，工具可直接调用
- [x] Operator Agent 框架（Phase 0，待 commit/push）：`plugins/operator/` — registry（风险分级/管理员鉴权/two-step confirm/audit trail）+ tools（git 只读、verify allowlist）+ `?op` 命令 + 20 个测试 + tsc 清洁 + live 加载验证

## Operator Agent 项目计划（交接给下一个 AI）

### Phase 0 — 框架骨架 ✅
- [x] `plugins/operator/` 插件结构（plugin.json + index.ts + registry.ts + tools.ts + tsconfig + vitest）
- [x] `registry.ts`：工具注册、风险分级（read/write/danger）、管理员鉴权 policy、two-step confirm（single-use/caller-bound/TTL）、audit trail（脱敏、cap 200）
- [x] `tools.ts`：`git`（只读 status/log/diff/show，写子命令不可达、路径穿越防护、sha 校验）、`verify`（typecheck/test/scan-secrets/preflight allowlist + 超时 clamp）
- [x] `?op` 命令：list / run / confirm / audit
- [x] 20 个测试 + tsc 清洁 + live 加载验证
- [ ] commit + push（本次交接任务）

### Phase 1 — 诊断能力（diag）
- [x] `diag` 工具：接入 traces/sessions handles（health / tail / why）
- [x] `?op diag why <messageId>`：反查 trace 链（events + outcome）
- [x] `?op diag health`：storage/sessions/traces 健康
- [x] `?op diag tail`：最近 N 条 trace 事件

### Phase 2 — 受控写入（patch/config）
- [x] `patch` 工具：read/write（仅 src/plugins/extensions，禁止 data/.env*/DB）
- [x] `config` 工具：read/write data/config/*（热重载由运行时处理）
- [x] diff 预览 + dry-run（read 子命令）

### Phase 3 — 生命周期（restart）
- [ ] `restart` 工具：Supervisor 组件级重启，两步确认
- [ ] 重启前自动 typecheck + test 门禁

### Phase 4 — LLM 调度层（真正的 agent）
- [ ] agent loop：LLM + tool-calling，把 diag/git/verify/patch/config/restart 作为 tools
- [ ] 安全：所有写操作 confirm token、所有操作 audit、secrets 永不入 context
- [ ] 交互：`?op agent <goal>` → agent 自主执行多步，每步回报告

### Phase 5 — 集成与硬化
- [ ] ACP server 接入 operator（外部编辑器可驱动）
- [ ] opencode-cli provider 接入（用 agent 当 model）
- [ ] 审计 UI（WebUI 展示 audit trail）
- [ ] 端到端测试：agent 诊断一个真实 bug 并修复

## 剩余（需人动手）
- [ ] 把本地提交 push 到远端（master ahead of origin/master）
- [ ] 安全收尾（见 `docs/AUDIT.md`）：在 Kilo 后台吊销并轮换泄露过的凭据；如需清历史再做 `git filter-repo` + 强制推送

## 已知 bug（待修）
- [x] `<@id>` 残留：adapter 剥离 mention 原文
- [x] 好感度数字滞后：默认 cooldown/interval 调优（1 / 5s）
