# MohoBot 目标架构

## 人格面与控制面

- **角色 Bot（Persona Plane）**：在 Discord 中聊天、观察、决定是否发言；不能执行服务器、数据库、插件安装或密钥操作。
- **墨染荷韵（Control Plane）**：唯一允许处理 `?` 管理指令的 Bot；仍只能调用经审核的动作白名单，所有高风险操作必须在本地 WebUI 二次确认并写审计。

`?` 必须同时满足：Bot 的 `admin.enabled=true`、发送者 Discord ID 在 `admin.userIds`。不满足时静默，不泄露权限状态。

## 数据分层：SQLite（唯一存储）

持久化只使用 SQLite：`storage.driver` 默认且唯一内置 `sqlite`（WAL、TTL、聊天索引），数据文件为 `data/mohobot.db`，备份在 `data/backups/`。注册表仍允许插件注册额外驱动（`storage.driver` 是开放字符串），但运行时不再内置 memory / MySQL / Redis / Kafka 任何驱动、镜像或 Outbox。

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

## 统一发言管线

```text
消息/事件 -> Topic Buffer -> 社交决策 -> 上下文/关系/设备/世界 -> 模型
  -> ReplyPlan 解码 -> Discord 格式化/分段/延迟 -> SQLite 存档/反思
```

模型输出只能得到 `ReplyPlan`：`ignore` 或受限 segments；发送器处理 Discord 限制、禁止 mass mention、分段和失败降级。

## 拟人化状态域

- `RelationshipGraph`：好感、熟悉、信任、尊重、边界、共同经历；跨私聊/群聊仅共享允许跨域的非敏感画像。
- `DeviceState`：电量、充电、网络、屏幕、勿扰、通知队列、习惯；是沉浸状态，非现实身份/设备声明。
- `WorldState`：时间、活动、天气、日程和事件；新闻只能进入候选情报库，经过来源、时间、注入清洗和置信度校验。
- `GroupStyle`：只允许短期调整句长、口语程度、表情和回复频率，不得改变安全规则或核心人格。

## 视觉与情报

视觉：附件校验 -> 下载隔离 -> URL/SSRF 防护 -> 内容/感知哈希 -> VLM 描述缓存 -> 结构化观察 -> 主模型决定回复。

情报：搜索 -> 信誉/域名规则 -> 去重 -> 正文清洗 -> 多来源核验 -> 候选库 -> 管理员批准后才成为长期事实。

建议搜索：自建 SearXNG 为长期低成本方案；Brave Search 有月度免费 credits 但需按当前条款注册；免费额度会变化，不能写死进产品承诺。
