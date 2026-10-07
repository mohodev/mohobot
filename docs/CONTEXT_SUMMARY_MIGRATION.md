# 移植方案：LLM 上下文总结压缩（上游 → TS 版）

> 状态：**已实现并验证**（`npm run typecheck` 干净；`npm test` 575 项全过；真实模型端到端摘要通过）。
> 下文 §1–§8 是实施前的方案原文；与最终实现的差异见 **§9**。
> 来源：`CarefreeSongs712/mohobot` → `mohobot/context_manager.py` 的 AI 总结压缩机制。
> 目标：让本地 Discord/TS 运行时在长对话里用 **LLM 总结**替代"直接丢弃最旧轮次"，提升长期连贯性。

---

## 1. 上游行为（已核对源码）

`ContextManager` 的语义（`role="summary"` 块）：

- **轮数计算**：普通消息每条计 0.5 轮（用户+回复 = 1 轮），总结块计 1 轮，最后 `ceil`。
- **触发**：`append_context` 后若 `_count_rounds(context) >= trim_at_rounds`（默认 40），触发压缩。
- **取头部**：`_head_for_compaction` = 最早的 `trim_remove_rounds` 轮（默认 15）∪ 超龄前缀，取更长者。
- **总结**：把头部交给 summarizer（`LLMService.summarize_context`）；成功则产出 `{role:"summary", content, timestamp}` 插到对话**最前**；失败/关闭则**直接裁剪**头部（防无限增长）。
- **再总结**：总结块视为 1 轮，下次压缩时连同更旧消息一起再总结（可嵌套）。
- **时间压缩（第二路径）**：`summary_age_hours`（默认 3h）之外的旧对话，即使没到 40 轮也可被收走；`sweep_all_sessions` 周期扫描（`sweep_interval_minutes` 默认 30），已压过的会话 24h 内不重复压（day-gate）；此路径总结失败**保留数据**下次重试（不裁剪）。
- **并发保护**：慢总结在锁外执行，合并时用内容比对（`_same_entries`）确认头部未被别的协程改过，否则跳过。

关键点：**上游没有硬性 `maxMessages` 裁剪**，压缩是主机制。

---

## 2. 本地现状与差距（已核对源码）

| 组件 | 文件 | 现状 |
|---|---|---|
| 会话管理器 | `src/session/manager.ts` | 内存 Map + storage 镜像。`#trim()` 按 `maxMessages`(默认20)/`maxChars`(8000) **硬裁最旧**。`buildContext` 组装 system + 记忆召回 + 时间戳历史。 |
| 会话契约 | `src/session/types.ts` | `SessionManagerLike`，`ChatMessage.role` 仅 `system\|user\|assistant`。 |
| 配置 | `src/config/schema.ts` | `SessionConfig`: maxMessages/maxChars/ttlSeconds/scope/persist。无 summary 相关项。 |
| 归档器 | `src/context-archiver/index.ts` | **JSONL 追加式审计归档**（gzip + TTL），注释虽写 "40-turn compression / summarize old context"，但**只做机械切片，从不调用 LLM**，且**不进入模型上下文**。pipeline `#archiveContext` 写入、runtime 每 5 分钟 `sweep()`。 |
| 管线 | `src/pipeline/pipeline.ts` | 追加 user turn → `buildContext` → 组装 system 消息 → `provider.chat` → 回复 → `completeExchange`。**注意**：管线会用 `messages.filter(m => m.role !== 'system')` **丢掉** buildContext 返回的 system 消息，再用 `systemPrompt/anchor/worldContext` 重建。 |
| Provider | `src/ai/router.ts` / `multi-router.ts` | 支持任务车道 `reply\|vision\|planner\|reflection\|profile\|world\|admin`，可做 primary→fallback。 |

### 三处必须解决的本地差异

1. **硬裁剪与总结冲突（最关键）**：本地 `maxMessages=20` 会先把历史砍到 20 条，`trim_at_rounds=40` 永远触发不了。移植时必须让**压缩先于/取代硬裁剪**，或把阈值与窗口对齐。
2. **`summary` 无法作为 `ChatMessage.role` 直接进模型**：OpenAI-compatible 不认 `role:"summary"`；而本地管线又把 session 里的 system 消息过滤掉。总结块必须以 **system 消息**形式在管线里显式注入。
3. **归档器 ≠ 活上下文**：真正喂给模型的是 `SessionManager`。移植要改的是 **SessionManager**，`ContextArchiver` 保持审计职责（可顺带修正其误导性注释）。

---

## 3. 设计决策（建议）

### 3.1 总结块存哪

**建议：作为 `Session` 的独立字段持久化，而非塞进 `messages`。**

- 新增 `Session.summary?: { text: string; updatedAt: number; coveredThrough?: number }`。
- 新增 `PersistedSession` 的 `summary` 字段，`recordVersion` 升到 **2**；`src/session/codec.ts` 接受 `<=2`（当前 `>1` 判 `future_version`，会触发 `writeBlocked`，必须同步放行）。
- 好处：不污染 `ChatMessage.role` 联合类型、不影响 `deleted` 墓碑逻辑、`#trim` 不必特殊照顾它。

### 3.2 总结块如何进模型

在管线组装 system 消息处**新增一条**（与 `anchor`/`worldContext` 同级）：

```
[systemPrompt(人设)] → [上下文锚点] → [世界状态] → [历史摘要] → [(媒体观察)] → 历史消息…
```

实现途径二选一：
- **A（推荐）**：`SessionManagerLike` 增加可选 `getSummary?(input): Promise<string|undefined>`；管线在组装处读取并注入。
- B：`buildContext` 返回摘要，管线保留（需放宽现有 filter，改动更大，不推荐）。

### 3.3 谁来做总结

SessionManager 不应直接依赖 Provider。**注入回调**（对齐上游 `set_summarizer`）：

- `SessionManagerOptions.summarizer?: (head: ChatMessage[]) => Promise<string>`。
- runtime 组装时注入，内部用 provider 调用，走**独立任务车道**（详见 3.6）。
- 未注入 → 压缩退化为现有硬裁剪，功能安全降级。

### 3.4 触发时机与硬裁剪的关系

- 在 `append()` / `completeExchange()` 落盘后检查轮数。
- 若 `rounds >= trimAtRounds`：切出头部（最旧 N 轮 ∪ 超龄）→ 异步总结 → 用摘要替换头部。
- **硬裁剪降级为兜底**：仅当总结失败、或压缩未启用时，才按 `maxMessages`/`maxChars` 裁。可选把 `maxMessages` 默认上调（如 60），给总结留出空间。
- 压缩期间到达的新消息要串行（`append` 已通过 `#pending` 串行化写入；总结需单独的 per-session in-flight 守卫，避免同一会话并发重复总结）。

### 3.5 周期时间压缩（可选，二期）

- 复用 runtime 现有 housekeeping / `context-archive-sweep` 任务，新增 `SessionManager.sweepCompaction()`。
- **扫描范围是开放问题**：SessionManager 只可靠地枚举内存 `#cache`；已 TTL 驱逐但仍在 storage 的会话需 `storage.query({prefix:'session:'})`（storage 已支持 prefix query）。
- 二期可先只扫内存缓存，够用；day-gate（`minIntervalHours`）逻辑照搬上游。

### 3.6 任务车道

- 建议在 `ModelTask` 增加 `'summary'`，并给 `TASK_TUNING` 配 `secondaryCapability:'chat'`、`background:true`（走后台预算、不抢用户回复）。
- 若不改类型，可暂复用 `'reflection'`（同为后台、chat 能力）——但语义不清晰，长期建议加 `summary`。

---

## 4. 配置设计（建议新增 `contextSummary` 块）

放在 `SessionConfig` 内，或独立 `ContextSummaryConfigSchema`。字段对齐上游：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | true | 总开关；关则退回硬裁剪 |
| `trimAtRounds` | 40 | 达到多少轮触发 |
| `trimRemoveRounds` | 15 | 每次总结最旧多少轮 |
| `summaryAgeHours` | 3 | 旧对话判定年龄 |
| `sweepEnabled` | true | 周期时间压缩开关（二期） |
| `sweepIntervalMinutes` | 30 | 周期扫描间隔（二期） |
| `minIntervalHours` | 24 | 已压会话再压的最小间隔（二期） |
| `prompt` | 内置模板 | 总结提示词（"全局概要 + 重点轮次浓缩"，要求保留人物/事实/情绪） |

热重载：配置对象挂在 config 上，`applyConfig` 后传入 SessionManager，与现有热重载一致。

---

## 5. 逐文件改动清单（落地时）

| 文件 | 改动 |
|---|---|
| `src/config/schema.ts` | 新增 `ContextSummary` schema，挂到 `SessionConfig`；`ResolvedBotConfig` 同步。 |
| `src/session/types.ts` | `Session.summary?`；`SessionManagerLike` 加 `getSummary?()`、可选 `sweepCompaction?()`。 |
| `src/storage/types.ts` | `PersistedSession` 加 `summary?`。 |
| `src/session/codec.ts` | `recordVersion` 接受 `<=2`；解析 `summary`。 |
| `src/session/manager.ts` | 轮数计算、头部分割、触发压缩、注入 summary、失败降级、in-flight 守卫、`getSummary`/`sweepCompaction`。 |
| `src/ai/router.ts` + `model-catalog.ts` | 新增 `summary` 任务车道与调优（或复用 reflection）。 |
| `src/bot/runtime.ts` | 用 provider 构造 summarizer 回调注入 SessionManager；配置热更新接线。 |
| `src/pipeline/pipeline.ts` | 组装 system 消息处注入 `[历史摘要]`。 |
| `src/context-archiver/index.ts` | 仅修正误导性注释（它不做 LLM 总结）；职责不变。 |
| `docs/ARCHITECTURE.md` / `UPSTREAM_COMPARE.md` | 更新为"已具备 AI 总结压缩"。 |

> 全部相对导入记得带 `.js` 后缀（`NodeNext`）。

---

## 6. 测试计划（`src/session/*.test.ts` 风格）

- 注入 mock summarizer，构造 >trimAtRounds 的会话，断言：头部被摘要替换、条数下降、摘要进 `getSummary`。
- summarizer 抛错 → 断言降级为硬裁剪，会话不增长、不丢失最近消息。
- 未配置/`enabled:false` → 行为等同现状（回归保护）。
- 持久化 round-trip：写入 `recordVersion:2` + summary，重新 hydrate 还原。
- 并发：同一会话并发 append 不产生重复总结（in-flight 守卫）。
- 边界：无时间戳旧数据、孤立 summary 块、半轮边界（未配对的 user 消息）。
- 管线：断言最终发给 provider 的消息含 `[历史摘要]` 且顺序在人设/锚点之后、历史之前。

---

## 7. 风险与开放问题

1. **`maxMessages` 与阈值对齐**：默认值需一起调整，否则总结不触发（见 3.4）。
2. **`recordVersion` 升级**：旧进程读到 v2 会 `future_version` 跳过并 `writeBlocked`；单向升级期间需确认无回滚需求（回滚前先降级清空或保留 v1 兼容读取）。
3. **总结成本/延迟**：每次总结是一次额外 LLM 调用；放后台车道 + 失败降级可缓解；建议加"总结调用计入 runtimeMetrics"。
4. **扫范围**：周期时间压缩是否覆盖已驱逐会话（storage prefix query）待定。
5. **隐私**：摘要是压缩后的对话内容，属敏感数据；持久化位置与现有 session 同库即可，不入日志。
6. **摘要质量**：需在 prompt 中显式要求保留人名/关系/未决事项，避免"概要"丢失关键上下文。建议上线后人工抽检。

---

## 8. 建议实施顺序

1. Schema + 类型 + codec（可独立合入，无行为变化）。
2. SessionManager 压缩核心 + mock summarizer 测试（功能可通过配置关闭）。
3. Provider 任务车道 + runtime 注入。
4. Pipeline 注入摘要块。
5. （二期）周期时间压缩 + WebUI/管理面板可视化。
