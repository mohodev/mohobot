# 上游对比报告 — carefreesongs712/mohobot（2026-08-23）

## 结论：同名不同种，无迁移必要

上游 = Python 3.10+ / OneBot v11 / **QQ 多 bot 框架**，26k 行，意识/潜意识双层架构（移植自 Agent-LuoTianyi）。
本项目 = TypeScript / Discord / 独立实现，16.8k 行，同一套"话题→注意→风格化→反思"思想的不同落地。

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
| 上下文 AI 总结压缩(40轮→总结15轮) | 无（maxMessages=20 硬裁剪+TTL+语义记忆补偿） | ⚠️ 设计差异 |
| 戳一戳反射 / TTS唱歌规划 / 图片phash去重 | 无 | ➖ QQ 特有，Discord 不适用 |
| OneBot v11 反向 WS 多 bot | Discord gateway 多 bot 配置 | ➖ 平台差异 |

## 决定
- **不迁移 Python**（RUNTIME_HARDEN_TODO 最后一项就此关闭）：上游平台(QQ)与本项目(Discord)不同，TS 版功能面已覆盖其通用架构思想。
- 可选增强（非必须）：session 满时 AI 总结压缩替代硬裁剪。当前 20 条+语义记忆够用，暂不做。
