# 上游对比报告 — carefreesongs712/mohobot（2026-08-23 初版，2026-10-11 增补）

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
| 上下文 AI 总结压缩(40轮→总结15轮) | `SessionManager` 滚动摘要（轮数/字符双触发，失败保留原文，见 docs/CONTEXT_SUMMARY_MIGRATION.md） | ✅ 已移植 |
| 戳一戳反射 / TTS唱歌规划 / 图片phash去重 | 无 | ➖ QQ 特有，Discord 不适用 |
| OneBot v11 反向 WS 多 bot | Discord gateway 多 bot 配置 | ➖ 平台差异 |

## 决定
- **不迁移 Python**（RUNTIME_HARDEN_TODO 最后一项就此关闭）：上游平台(QQ)与本项目(Discord)不同，TS 版功能面已覆盖其通用架构思想。
- ~~可选增强：session 满时 AI 总结压缩替代硬裁剪~~ → 已于 2026-10 实现（`session.contextSummary`）。

## 2026-10-11 增补：上游功能跟随

8-23 报告后，本项目又按上游数据源与规则跟随了一批功能（QQ 特有交互除外，全部按 Discord 原生重写）。结论不变：**仍不迁移 Python**。

| 上游 | 本项目 | 状态 |
|---|---|---|
| `mohobot/emotion/`（好感/亲密/8维情绪/关系阶段） | `src/emotion/` + `?好感度` / `?关系阶段` / `?好感排行` | ✅ 已移植（默认关闭，分析失败熔断+关键词降级） |
| `mohobot/services/persona_ab*.py`（人设 A/B） | `src/pipeline/persona-ab.ts` + `?ab` | ✅ 已移植（图片卡片改文本卡片，其余规则保留） |
| `usage_stats`（用量统计） | `src/ai/usage.ts` + `?用量` / `?用量 会话` | ✅ 已跟随（按调用类型记账 + 会话 Top10 + 平均每次） |
| `mohobot/music_knowledge/`（歌曲库） | `src/songs/` + `scripts/sync-songs.ts` + `?同步歌曲` | ✅ 已跟随（VCPedia 分类分页 + revisions 取 wikitext） |
| 搜索（上游用 Anysearch MCP） | `plugins/search`（Anysearch + DuckDuckGo + Wikipedia 三后端链） | ✅ 数据源跟随，Discord 原生 |
| 群互动/迎新/运营 | `plugins/fun`（占卜/66 梗）/ `plugins/welcome` / `plugins/bilibili` / `?广播`（`src/admin/broadcast.ts`） | ✅ Discord 原生重写（广播只覆盖服务器、不打扰私聊） |
| 聊天治理 | `?ban` / `?unban` / `?banlist`、repeat-guard | ✅ 已有 |
| `services/llm_tools.py`（插件声明的 LLM 工具注册表 + function calling） | `src/ai/tools.ts`（ChatToolRegistry + executeToolCall）+ provider tools 支持（`src/ai/openai-compatible.ts`，非流式）+ pipeline 工具循环（`ai.tools.enabled` 默认关，allowlist + maxRounds）+ 内置 `search_song` 工具 | ✅ 已移植（opt-in，默认关） |
| `utils/reply_filter.py`（回复产物过滤器 FORMAT/DROP/VOICE） | `src/pipeline/reply-filter.ts`（流式安全、比较式不误伤、嵌套 drop、超长救援；`ai.replyFilter` 默认开） | ✅ 已移植（VOICE 的朗读文本在 Discord 无消费方，仅剥标签保内容） |
| 戳一戳反射 / TTS 唱歌规划 / 图片 phash 去重 / OneBot v11 | 无 | ➖ QQ 特有，Discord 不适用（维持不做） |

> 2026-10-17 复核：对上游 `mohobot/` 全模块（services/interceptors/utils/顶层）重新核对后，发现 10-11 版漏了两项通用能力——`llm_tools.py`（LLM 工具调用进回复路径）与 `reply_filter.py`（回复产物清洗）——本轮已补（见表内对应行）。至此，**排除 QQ 特有项后，通用功能面与上游对齐**。
