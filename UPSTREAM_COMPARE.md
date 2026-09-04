# 上游对比报告 — carefreesongs712/mohobot（2026-09-04 更新）

## 结论：同名不同种，通用能力已移植并海外化

上游 = Python 3.10+ / OneBot v11 / **QQ 多 bot 框架**，26k 行，意识/潜意识双层架构（移植自 Agent-LuoTianyi）。
本项目 = TypeScript / Discord / 独立实现，同一套"话题→注意→风格化→反思"思想的不同落地。

## 架构映射

| 上游 (Python/QQ) | 本项目 (TS/Discord) | 状态 |
|---|---|---|
| TopicPlanner 缓冲判完 | topic-buffer.ts | ✅ 对应 |
| AttentionPlanner 记忆召回 | semantic-memory + rerank 分层召回 | ✅ 对应 |
| MainChat 结构化回复 | reply-plan 协议（分段+typing） | ✅ 对应且更细 |
| ReflectionWorker 回合后反思 | profile-reflection | ✅ 对应 |
| SubconsciousMemory 向量库 | embeddings(可降级) | ✅ 对应 |
| LLM 备用模型回退 | multi-router TaskRoute primary→fallback | ✅ 已有 |
| 群聊最近消息注入 | topic-buffer 共享 timeline | ✅ 已有 |
| 说话人标注 | pipeline name=username | ✅ 已有 |
| 上下文 AI 总结压缩(40轮→总结15轮) | session.summary + summarizer.ts（summary 角色） | ✅ 已实现 |
| 封禁系统（reneban 移植） | plugins/ban（静默忽略 + 管理命令） | ✅ 已实现 |
| 环境感知插件（时间/节日/农历/节气） | plugins/perception（时段/工作日/国际节日，去农历节气） | ✅ 已实现（海外化） |
| Anysearch 联网搜索 | plugins/web-search（SearXNG/Brave/Tavily） | ✅ 已实现（海外化） |
| 网易云点歌 / 歌曲知识 | plugins/music（iTunes Search API） | ✅ 已实现（海外化） |
| 新好友/新入群欢迎 | plugins/welcome（guild:member:join） | ✅ 已实现 |
| 戳一戳反射 / TTS唱歌 / 图片phash去重 | 无 | ➖ QQ 特有，Discord 不适用 |
| 抽老婆 / 关系管理器 / 广播 / 数字梗 | 无 | ➖ QQ 社交玩法，不移植 |
| OneBot v11 反向 WS 多 bot | Discord gateway 多 bot 配置 | ➖ 平台差异 |

## 决定
- **不迁移 Python**：上游平台(QQ)与本项目(Discord)不同，TS 版已覆盖其通用架构思想。
- 已将平台无关的上游核心功能（总结压缩、封禁、环境感知、联网搜索、歌曲搜索、欢迎）移植为 TS 插件或核心模块，并将网易云/农历节气等国内依赖替换为 iTunes/SearXNG/国际节日表。
