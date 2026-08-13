# MohoBot

> 可长期运行、可扩展、故障隔离的 Discord AI Runtime。

MohoBot 当前已经具备：Discord/Console 网关、OpenAI-compatible 多供应商路由、SQLite 会话持久化、Outbox、Embedding/Rerank 语义记忆、世界/设备/关系状态、插件热加载、多 Bot、运行监督、管理 WebUI 和首次启动向导。

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
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | Vitest 回归测试 |
| `npm run build` | 构建到 `dist/` |
| `npx tsx scripts/verify-hotreload.ts` | 验证插件热加载 |
| `npx tsx scripts/verify-extensibility.ts` | 验证四类扩展点 |

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

优先级：Schema 默认值 < `data/provider.yaml` < `config/global.yaml` < `config/bots/*.yaml` < 环境变量。

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

`config/global.yaml` 保存运行参数；`data/provider.yaml` 保存 Provider 默认项；密钥不得写进 YAML，哪怕只是注释。NVIDIA Build/NIM 模型目录仅作动态参考，启用前需按当前账号做健康检查。

可选扩展配置见 `data/storage/remote.example.yaml`：SQLite 本地热路径、Outbox 异步同步 MySQL、Redis 短 TTL 缓存/限流、Kafka 多节点事件流。未配置远程服务时全部自动降级为本地实现。

## 插件

插件位于 `plugins/<id>/`，入口由 `plugin.json` 指定。示例：

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
