# 遗留清单（2026-09-04 更新）

## 本轮完成 ✅（上游核心功能移植 + 海外化）
- [x] AI 上下文总结压缩：`src/session/summarizer.ts` + `SessionManager` 接入 + `summary` 角色 + `session.summary` 配置；provider 映射 `summary→user`，失败自动降级硬裁剪（单测覆盖）
- [x] 情感/拟人化系统插件：`plugins/emotion`（好感度/亲密度 + 8 维情绪、pre-LLM 语气注入、post-LLM 二次情感分析 + 关键词降级、关系阶段滞后演进、长期互动记忆；管理命令粗粒度摘要，不暴露原始分值）
- [x] 封禁名单插件：`plugins/ban`（静默忽略 + `!ban`/`!ban-all`/`!pass`/`!unban`/`!banlist`/`!ban-help`，管理命令需管理员；优先级 频道解禁 > 频道封禁 > 全局解禁 > 全局封禁）
- [x] 联网搜索插件：`plugins/web-search`（SearXNG 默认无 Key / Brave / Tavily；`!search`/`!web`，失败降级为空结果）
- [x] 歌曲搜索插件：`plugins/music`（iTunes Search API 无 Key，`!song`/`!music`，海外替代网易云）
- [x] 环境感知插件：`plugins/perception`（时段/工作日/国际节日/群聊私聊；去除农历与二十四节气）
- [x] 新成员欢迎插件：`plugins/welcome`（新增 `guild:member:join` Moho 事件，占位符 {user}/{username}/{count}）
- [x] 多 Bot 核对：本仓库已原生具备（config/bots/*.yaml 多 bot + Supervisor 隔离 + per-bot 状态目录 + multibot-state-isolation 单测），上游的 OneBot 反向 WS 多 bot 属平台差异，无需移植
- [x] 验证：`npm run typecheck`、`npm run build`、`npm test`（542 passed）、六个插件各自 `npx tsc -p` + `npx vitest run` 全绿；console 离线冒烟通过（emotion 插件加载、mock 回复、管理命令静默正常）

## 早前完成 ✅
- [x] 管理端 Discord 入站/出站聊天日志：GET /api/ops/discord-chat-log（权限 chats.log.read，operator+，内存环形500条不落盘，summary≤500字符scrub）— 已上线实测
- [x] 端到端验证：console 全链路真实进程冒烟通过；生产实例 debug-chat 冒烟 ok
- [x] 上游对比：见 UPSTREAM_COMPARE.md — 同名不同种，通用能力已移植

## 仍需人工验证（生产环境）
- [ ] 在 Discord 群里 @墨染荷韵 说句话 → /api/ops/discord-chat-log 出现 in+out 记录（终极闭环）
- [ ] 长会话触发 `session.summary` 压缩后，检查 `data/mohobot.db` 中会话首条为 `summary` 角色（需真实 Provider 凭据）
- [ ] `plugins/web-search` 切到可访问的 SearXNG 实例或配置 Brave/Tavily Key 后实测 `!search`
