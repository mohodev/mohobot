# MohoBot 目标架构

## 人格面与控制面

- **角色 Bot（Persona Plane）**：在 Discord 中聊天、观察、决定是否发言；不能执行服务器、数据库、插件安装或密钥操作。
- **墨染荷韵（Control Plane）**：唯一允许处理 `?` 管理指令的 Bot；仍只能调用经审核的动作白名单，所有高风险操作必须在本地 WebUI 二次确认并写审计。

`?` 必须同时满足：Bot 的 `admin.enabled=true`、发送者 Discord ID 在 `admin.userIds`。不满足时静默，不泄露权限状态。

## 数据分层：SQLite（唯一存储）

持久化只使用 SQLite：`storage.driver` 默认且唯一内置 `sqlite`（WAL、TTL、聊天索引），数据文件为 `data/mohobot.db`，备份在 `data/backups/`。会话、World、Device、Affinity、记忆、任务、配置发布与管理审计均通过 SQLite 持久化。World/Device 使用 2 秒进程内 TTL cache，跨进程的新鲜度仍是已知边界。历史 JSON 文件只作为一次性/只读迁移输入，不再写回；`VersionedJsonStore` 不得用于新生产状态。注册表仍允许插件注册额外驱动（`storage.driver` 是开放字符串），运行时不再内置 memory / MySQL / Redis / Kafka 驱动或异步镜像。

### SQLite 承载的内容

- 活跃会话和最近上下文
- 当前世界/设备状态
- 关系缓存、限流、待处理任务、管理审计
- 最近 N 天聊天索引

SQLite 是用户回复路径的唯一真相来源。初始化失败时按 `storage.allowEphemeralFallback` 显式决定是否降级为无持久化运行，否则拒绝启动（fail closed）。

历史设计中的 MySQL 归档、Redis 缓存、Kafka 事件流与 Outbox 异步镜像已在“只保留 SQLite 存储”的重构中整体移除；如需多节点或远程归档，应通过插件注册新的存储驱动重新引入，而不是复活内置分支。

## 模型阵列

任务类型：`reply`、`vision`、`planner`、`reflection`、`profile`、`world`、`admin`。

- Provider 仍为 OpenAI-compatible；可接 NIM、Kilo、Ollama、vLLM 或其他厂商。
- 本地预算以 **RPM 绝对值** 配置；`rpm: 0` 表示不限制，适配无明确上限的服务。
- NVIDIA NIM 40 RPM：建议 `rpm: 34`、`reserveRpm: 6`、并发 `4`。
- 上游 429、日志与延迟统计未来可建议下调预算，但不能自动修改生产配置；需管理员确认。
- 背景任务被优先限流，用户直接消息、视觉和管理读取保留能力。

模型运营平面包括 model catalog、health coordinator、circuit breaker、fallback、availability overlay 和 usage/cost 统计，并已有跨 Bot Model Operations API/WebUI。当前主要差距是路由 trace 可解释性、端到端运营契约和持续评测。

## 平台适配器边界

平台无关契约位于 `src/platform/`：`Gateway`、投递结果、连接状态和可选 workspace/guild capability。`BotRuntime` 与 Gateway registry 只依赖该契约，不导入 `discord.js`。

`src/platform/index.ts` 是组合根，负责将内置 Discord/Console adapter 与 Runtime 注入的 gateway registry 连接起来；插件/extension 可使用同一注册表添加任意平台 ID。`src/discord/` 只保存 Discord/Console 具体实现和原生事件归一化。旧 `src/discord/types.ts`、`src/discord/index.ts` 保留兼容导出，新增代码应使用 `src/platform/`。

目前内置且实际可运行的平台仍只有 Discord 与 Console；OneBot/QQ/WebChat 没有被这次类型迁移自动实现。新增 Adapter 必须提供入站 MohoMessage 归一化、出站 DeliveryResult、连接状态、取消/停止语义和平台能力声明，并覆盖断线、重连、重复/不确定投递测试。

## 统一发言管线

```text
消息/事件 -> Topic Buffer -> 社交决策 -> 上下文/关系/设备/世界 -> 模型
  -> ReplyPlan 解码 -> Discord 格式化/分段/延迟 -> SQLite 存档/反思
```

模型输出只能得到 `ReplyPlan`：`ignore` 或受限 segments；发送器处理 Discord 限制、禁止 mass mention、分段和失败降级。Pipeline 已拆为 orchestration、conversation context、tool loop、streaming buffer 与 reply delivery 等模块，边界和必须保持的不变量见 [`PIPELINE.md`](PIPELINE.md)。

AdminServer 同样拆分为 HTTP/auth/policy/nonce/audit 入口、ApiRouter 和 Models/Ops/Config-Users/Characters-MCP/Memory/Knowledge/World 领域 handler。鉴权链路与 handler 边界见 [`ADMIN_API.md`](ADMIN_API.md)。

输入侧用户文本、附件观察、OCR/VLM、MCP 返回、工具结果和长期记忆均属于不可信数据；它们不得因为被放入 system/data block 就获得 instruction 权限。当前 `wrapUntrusted` 与 provenance 已接入 pipeline、AI tools、MCP bridge、media OCR/VLM 和 memory recall，并有跨来源注入回归测试；新增数据入口必须沿用该协议。

## 拟人化状态域

- `RelationshipGraph`：好感、熟悉、信任、尊重、边界、共同经历；跨私聊/群聊仅共享允许跨域的非敏感画像。
- `DeviceState`：电量、充电、网络、屏幕、勿扰、通知队列、习惯；是沉浸状态，非现实身份/设备声明。
- `WorldState`：已实现 SQLite 状态、事件来源链、信任/确认、阶段演化、Future Task 的受限 tick handler、trace/replay 与 bot domain 隔离基础。World/Device 仍有 2 秒进程内 TTL cache，多实例需补跨进程 stale-cache 策略。新闻只能进入候选情报库，经过来源、时间、注入清洗和置信度校验。
- `GroupStyle`：只允许短期调整句长、口语程度、表情和回复频率，不得改变安全规则或核心人格。

## 视觉与情报

视觉：附件校验 -> 下载隔离 -> URL/SSRF 防护 -> 内容/感知哈希 -> VLM 描述缓存 -> 结构化观察 -> 主模型决定回复。

情报：搜索 -> 信誉/域名规则 -> 去重 -> 正文清洗 -> 多来源核验 -> 候选库 -> 管理员批准后才成为长期事实。

建议搜索：自建 SearXNG 为长期低成本方案；Brave Search 有月度免费 credits 但需按当前条款注册；免费额度会变化，不能写死进产品承诺。
