# MohoBot 目标架构

## 人格面与控制面

- **角色 Bot（Persona Plane）**：在 Discord 中聊天、观察、决定是否发言；不能执行服务器、数据库、插件安装或密钥操作。
- **墨染荷韵（Control Plane）**：唯一允许处理 `?` 管理指令的 Bot；仍只能调用经审核的动作白名单，所有高风险操作必须在本地 WebUI 二次确认并写审计。

`?` 必须同时满足：Bot 的 `admin.enabled=true`、发送者 Discord ID 在 `admin.userIds`。不满足时静默，不泄露权限状态。

## 数据分层：SQLite + MySQL + Redis

### SQLite（本地热路径、离线可用）

- 活跃会话和最近上下文
- 当前世界/设备状态
- 最近关系缓存、限流、待处理任务
- 最近 N 天聊天索引

SQLite 是用户回复路径的首选，远程数据库不可用时必须继续工作。

### MySQL（远程权威归档与副本）

- 角色日记、角色包版本、长期记忆正本
- 用户画像、关系事件、社交图谱
- 归档聊天记录和审计日志
- 可选的 SQLite 热数据定时镜像

模式：`local-only`、`async-mirror`、`remote-authoritative`。

- `local-only`：默认；不需要远程服务。
- `async-mirror`：SQLite 先落盘，Outbox 后台重试同步 MySQL；适合聊天记录和运营数据。
- `remote-authoritative`：仅日记/长期角色文稿等冷数据允许；读操作有随机可配置延迟以支持沉浸模式，但必须在产品/角色设定中明确，不可冒充真实人类设备或在线状态。

MySQL 写入必须通过最小权限账号、TLS、固定 schema 与参数化查询。禁止把任意 SQL 暴露给模型。

### Redis（可选加速层，不是真相来源）

适合：
- 分布式 RPM/并发限流
- Topic Buffer、通知/设备状态短 TTL
- 任务去重、幂等键、热会话缓存
- 多实例时的轻量队列

不适合：角色日记、永久记忆、审计正本。配置 ACL、专用 key 前缀与 TTL；禁止 `FLUSHALL` 类模型动作。

### Kafka（规模化后才启用）

仅在多进程/多机、需要可靠异步事件流水（聊天归档、反思、画像、世界事件、分析）时启用。

当前单机版本使用 SQLite Outbox + `OutboxWorker`；可选 `MySqlRemoteMirror` 通过参数化、幂等 event_id 写入远程归档，可选 `KafkaMirror` 发布版本化 envelope。二者均由注入的最小客户端接口提供驱动，未配置时不加载、不成为启动依赖。

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
  -> ReplyPlan 解码 -> Discord 格式化/分段/延迟 -> 存档/反思 Outbox
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
