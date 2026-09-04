# MohoBot

> 可长期运行、可扩展、故障隔离的 Discord AI Runtime。

MohoBot 当前已经具备：Discord/Console 网关、OpenAI-compatible 多供应商路由、SQLite 会话持久化、Outbox、Embedding/Rerank 语义记忆、世界/设备/关系状态、插件热加载、多 Bot、运行监督、管理 WebUI 和首次启动向导；以及从上游 carefreesongs712/mohobot 移植并海外化的核心能力——AI 上下文总结压缩、联网搜索、封禁名单、环境感知、新成员欢迎、歌曲搜索（iTunes）。

> **状态说明：** MySQL/Redis/Kafka 是可选扩展，远程同步契约已定义但不应在未配置时阻塞本地运行。模型目录是动态参考快照，不把 NVIDIA Free Endpoint 数量写死。详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/IMMERSION.md`](docs/IMMERSION.md) 与 [`docs/AUDIT.md`](docs/AUDIT.md)。

## 快速开始

```bash
npm install
npm run setup -- --non-interactive
# 编辑 .env.local：DISCORD_TOKEN 和所选 Provider 的 API Key
npm start
```

首次启动向导会创建 `.env.local`、随机管理员 Token、运行目录和 SQLite；已有 `.env.local` 不会被覆盖。管理 WebUI 默认在 `127.0.0.1:3210`，使用 `MOHO_ADMIN_TOKEN` 登录。

没有凭据也能离线跑通完整自然语言管线：

```bash
printf 'hello\n' | MOHO_ADAPTER=console AI_API_KEY= npx tsx src/index.ts
```

角色 Bot 不执行 `!` 文本命令；管理 Bot 只接受已鉴权的 `/status`、`?status` 等管理入口。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm start` | 启动 Runtime |
| `npm run dev` | 监听源码并重启 |
| `npm run preflight` | 离线检查配置、目录写权限与 SQLite 迁移 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | Vitest 回归测试 |
| `npm run build` | 构建到 `dist/` |
| `npm run check-update` | 只检查本地 Git/Node 状态，不联网、不修改 |
| `npm run update` | 保守生产更新（会 fetch、备份、验证，详见下文） |
| `npx tsx scripts/verify-hotreload.ts` | 验证插件热加载 |
| `npx tsx scripts/verify-extensibility.ts` | 验证四类扩展点 |

## 生产更新

先做完全离线的检查：

```bash
npm run check-update
```

`check-update` 只检查 Node.js ≥ 22、Git 仓库、当前分支/upstream、未合并文件、tracked 工作树和 ahead/behind；**不会执行 `git fetch`、安装依赖、备份或重启**。未跟踪的日志和运行数据不会阻止检查，但 tracked 文件或 index 有改动时会拒绝继续。

确认维护窗口后再执行更新：

```bash
npm run update
```

更新器会按以下固定顺序执行：

1. 原子创建 `.mohobot-update.lock/`，防止两个更新进程并行；
2. 检查分支、upstream、tracked dirty/unmerged 和提交图；
3. 根据 `MOHO_STORAGE_PATH` / `.env.local` / `config/global.yaml` 定位 SQLite；
4. 使用 `better-sqlite3` backup API 备份到 `data/backups/`，再以只读方式运行 `PRAGMA quick_check`；
5. `git fetch --prune` 后再次检查提交图，只执行 `git merge --ff-only @{u}`；
6. 依次执行 `npm ci`、非交互 setup/migration preflight、typecheck、test、build；
7. 仅在明确给出时执行 restart argv，随后可等待 HTTP health。

默认不允许本地分支领先 upstream。审核确认本地提交是预期部署内容后，才使用：

```bash
npm run update -- --allow-ahead
```

更新器不会使用 `reset`，失败时也不会自动恢复数据库或代码。它会打印更新前 HEAD、当前 HEAD 和已验证备份路径，留给运维人员判断恢复方式。

### 可选重启与健康检查

restart command 必须是 **JSON argv 数组**，不会经过 shell：

```bash
npm run update -- \
  --restart-command='["systemctl","restart","mohobot"]' \
  --health-url='http://127.0.0.1:3210/api/status'
```

不要传 `systemctl restart mohobot` 这类 shell 字符串；更新器会拒绝。复杂流程请先写成受审计的独立脚本，再以 `['/absolute/path/to/script','arg']` 的 argv 形式调用。health URL 只接受 HTTP/HTTPS，默认最多等待 90 秒，可用 `--health-timeout-ms=120000` 调整。

锁目录不会在崩溃后被自动强行接管。确认没有更新进程后，才能人工删除 `.mohobot-update.lock/`。更新命令本身会访问配置的 Git upstream；只有用户实际运行 `npm run update` 时才会发生外部 fetch。

## 架构

```text
Supervisor
  └─ BotRuntime (每个 Bot 独立)
       ├─ Gateway: Discord / Console / 插件扩展
       ├─ MessagePipeline: 过滤 → 命令 → 会话 → AI → 回复
       ├─ Provider: OpenAI-compatible / Mock / Kilo 插件
       ├─ SessionManager: 短期上下文 + 持久化 + MemoryAdapter
       └─ PluginManager: 隔离、超时、热加载、扩展注册

Storage: SQLite / Memory
Extension registries: Provider / Gateway / Storage / Memory
```

关键约束：

- `discord.js` 只允许出现在 `src/discord/`。
- 同一会话的消息串行处理，避免 AI 回复乱序污染上下文。
- 插件异常不会拖垮 Runtime；失败加载会回收已注册扩展。
- 插件入口必须留在插件目录内，包含符号链接边界检查。
- 密钥只放 `.env`；日志会结构化和文本化脱敏。
- 入站聊天日志只记录通过访问控制并进入消息管线的消息。

## 配置

优先级：Schema 默认值 < `data/provider.yaml` < `data/provider.local.yaml` < `config/global.yaml` < `config/global.local.yaml` < `config/bots/*.yaml` < `config/bots/*.local.yaml` < 环境变量。

`*.local.yaml` 用于机器私有覆盖并已加入 `.gitignore`。对象会递归合并，数组和标量整体替换；例如 `config/bots/main.local.yaml` 只覆盖 `main.yaml`，不会被加载成第二个 Bot。旧配置文件无需改名，`version` 字段可选。可从 `config/global.local.example.yaml` 复制所需结构。

| 环境变量 | 用途 |
|---|---|
| `DISCORD_TOKEN` | Discord Bot Token |
| `MOHO_BOT_<ID>_DISCORD_TOKEN` | 单 Bot Discord Token |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | 通用 AI Provider |
| `MOHO_BOT_<ID>_AI_API_KEY` | 单 Bot AI Key |
| `KILO_API_KEY` | Kilo Provider |
| `MOHO_ADAPTER` | `discord` 或 `console` |
| `MOHO_STORAGE_PATH` | SQLite 路径 |
| `LOG_LEVEL` | 日志级别 |

`config/global.yaml` 保存可跟踪的运行参数；`data/provider.yaml` 保存可跟踪的 Provider 默认项；对应的 `.local.yaml` 只放机器差异，仍不得写入密钥（密钥只从环境变量读取）。新版本增加的未知字段在旧版运行时只会告警并忽略，不会阻断启动。NVIDIA Build/NIM 模型目录仅作动态参考，启用前需按当前账号做健康检查。

可选扩展配置见 `data/storage/remote.example.yaml`：SQLite 本地热路径、Outbox 异步同步 MySQL、Redis 短 TTL 缓存/限流、Kafka 多节点事件流。未配置远程服务时全部自动降级为本地实现。

### AI 上下文总结压缩

会话超长时，最早的历史轮次会通过 Bot 自身的 Provider 压缩成一个 `summary` 块（角色 `summary`）插入对话最前，而不是被硬裁剪直接丢弃；总结块会参与后续的再总结。总结失败或未配置 Provider 时自动降级为 `maxMessages` / `maxChars` 硬裁剪，绝不阻塞回复。开关在 `config/global.yaml` / `config/bots/*.yaml` 的 `session.summary`：`triggerMessages`（触发轮数）、`removeMessages`（每次折叠的最早轮数）、`keepMessages`（压缩后保留的最新轮数）。

## 插件

插件位于 `plugins/<id>/`，入口由 `plugin.json` 指定。内置插件：

- `ban` — 全局封禁名单：被封禁用户的消息被静默忽略（`!ban` / `!ban-all` / `!pass` / `!unban` / `!banlist`，管理命令需管理员）。
- `emotion` — 情感/拟人化系统：per-user 好感度/亲密度 + 8 维情绪，pre-LLM 语气注入、post-LLM 二次情感分析（LLM 失败自动降级关键词）、关系阶段演进（初识/深化/承诺/共生 + 冷淡/反感/敌对）与长期互动记忆；管理命令 `!情绪` / `!情绪排行` / `!设置好感` / `!设置亲密` / `!重置情绪`（仅管理员，且只返回粗粒度摘要，不暴露原始分值）。
- `web-search` — 联网搜索（`!search` / `!web`）：默认 SearXNG（无需 Key），可切换 Brave / Tavily。
- `music` — 歌曲搜索（`!song` / `!music`）：iTunes Search API（无需 Key，海外替代网易云）。
- `perception` — 环境感知：在 AI 调用前注入时段、工作日/周末、国际节日与群聊/私聊上下文。
- `welcome` — 新成员欢迎：订阅 `guild:member:join`，在指定频道发送可定制欢迎语。
- `ping` / `human-simulator` / `model-catalog` / `kilo-provider` / `devtools` — 原有参考与运维插件。

示例：

```ts
import type { Plugin } from '../../src/plugins/types.js';

const plugin: Plugin = {
  name: 'hello',
  onLoad(ctx) {
    ctx.registerCommand({ name: 'hi', execute: () => 'hey!' });
  },
};
export default plugin;
```

`devtools` 含开发/诊断能力，**默认关闭**。启用后仍只能通过管理员 allowlist、鉴权 Interaction 或本地 WebUI 使用，不会恢复公开 `!` 命令。

## 交互入口

角色 Bot 不执行 `!` 文本命令。普通 Bot 不注册管理 Slash；墨染荷韵仅对授权管理员注册 `/status`，并支持 WebUI 管理入口。插件命令只能通过经过鉴权的 Interaction 或管理面板触发。

## 安全提示

仓库曾提交过疑似真实 Kilo Token。当前工作树已移除，但 Git 历史中的值不会因普通删除而消失：必须在 Kilo 后台撤销并轮换，然后按团队策略清理 Git 历史与缓存副本。

## 路线图

1. 管理 API + 鉴权 + 只读状态面板
2. 角色模型与角色 CRUD / 导入
3. 可检索长期记忆实现与管理
4. 测试聊天、角色互聊
5. 行为引擎、世界状态与事件
6. MCP 工具权限与审计

不要把规格页当成功能实现；每一阶段必须有 API、UI、权限边界和自动化测试闭环。
