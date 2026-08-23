# 遗留清单（2026-08-23 更新）

## 全部完成 ✅
- [x] 管理端 Discord 入站/出站聊天日志：GET /api/ops/discord-chat-log（权限 chats.log.read，operator+，内存环形500条不落盘，summary≤500字符scrub）— 已上线实测
- [x] 端到端验证：console 全链路真实进程冒烟通过（入站落库→kilo/hy3非fallback回复→出站落库→人设文本，19.1s）；生产实例 debug-chat 冒烟 4.2s ok
- [x] 上游对比：见 UPSTREAM_COMPARE.md — 结论：同名不同种(QQ/Python vs Discord/TS)，不迁移 Python，无功能性落后

## 唯一剩余（需你动手）
- [ ] 在 Discord 群里 @墨染荷韵 说句话 → 我查 /api/ops/discord-chat-log 出现 in+out 记录 = 终极闭环
