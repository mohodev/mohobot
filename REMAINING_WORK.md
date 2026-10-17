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

## Operator Agent 剩余（Phase 5）
- [ ] ACP server 接入 operator（外部编辑器可驱动）
- [ ] opencode-cli provider 接入（用 agent 当 model）
- [ ] WebUI 审计视图（目前仅有 API）
- [ ] 端到端测试：agent 诊断一个真实 bug 并修复

## 需人动手
- [ ] 安全收尾（见 `docs/AUDIT.md`）：在 Kilo 后台吊销并轮换泄露过的凭据；如需清历史再做 `git filter-repo` + 强制推送
