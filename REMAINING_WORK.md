# 遗留清单（2026-10-11 更新）

## 全部完成 ✅
- [x] 终极闭环（2026-10-11 用户确认）：在 Discord 群里 @墨染荷韵 说话，`GET /api/ops/discord-chat-log` 出现 in+out 记录
- [x] 管理端 Discord 入站/出站聊天日志：GET /api/ops/discord-chat-log（权限 chats.log.read，operator+，内存环形500条不落盘，summary≤500字符scrub）— 已上线实测
- [x] 端到端验证：console 全链路真实进程冒烟通过（入站落库→kilo/hy3非fallback回复→出站落库→人设文本，19.1s）；生产实例 debug-chat 冒烟 4.2s ok
- [x] 上游对比：见 UPSTREAM_COMPARE.md — 结论不变：同名不同种(QQ/Python vs Discord/TS)，不迁移 Python；10 月又跟随了上游数据源与运营功能（emotion / persona_ab / usage_stats / music_knowledge / 搜索），QQ 特有能力除外
- [x] 10 月功能批（本地 27 个提交，待 push）：好感度与关系阶段（`src/emotion/`）、人设 A/B（`src/pipeline/persona-ab.ts`）、用量统计与会话排行（`?用量` / `?用量 会话`）、VCPedia 歌曲库（`src/songs/` + `?同步歌曲`）、三后端搜索（`plugins/search`）、趣味与迎新插件（`plugins/fun` / `welcome` / `bilibili`）、两步广播（`?广播`）、ban 与 repeat-guard、opencode-cli + ACP、SQLite-only、`data/` 单卷、滚动上下文摘要、secret 扫描

## 剩余（需人动手）
- [ ] 把本地 27 个提交 push 到远端（`master` ahead of `origin/master`）
- [ ] 安全收尾（见 `docs/AUDIT.md`）：在 Kilo 后台吊销并轮换泄露过的凭据；如需清历史再做 `git filter-repo` + 强制推送
