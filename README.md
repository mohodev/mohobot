# MohoBot

> 可长期运行、可扩展、故障隔离的 Discord AI Runtime。

MohoBot 当前已经具备：Discord/Console 网关、OpenAI-compatible 与 Kilo Provider、SQLite 会话持久化、插件热加载、多 Bot、短期会话记忆、长期记忆适配器接口、运行监督与离线测试。

> **状态说明：** `webui/` 目前是产品规格，不是已经可用的管理后台。角色系统、世界模拟器、行为引擎、MCP、向量记忆和完整 WebUI 尚未实现。详见 [`webui/index.md`](webui/index.md) 与 [`docs/AUDIT.md`](docs/AUDIT.md)。

## 快速开始

```bash
npm install
cp .env.example .env
# 在 .env 填 DISCORD_TOKEN 和所选 Provider 的 API Key
npm start
```

没有凭据也能离线跑通完整消息管线：

```bash
printf '!help\nhello\n' | MOHO_ADAPTER=console AI_API_KEY= npx tsx src/index.ts
```

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

`config/global.yaml` 保存运行参数；`data/provider.yaml` 保存 Provider 默认项；密钥不得写进 YAML，哪怕只是注释。

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

`devtools` 含 `!ai`、`!bench`、`!say` 等管理能力，**默认关闭**。如果要启用，先增加管理员 allowlist，不要直接暴露给公开频道。

## 内置命令

`!help` · `!reset` / `!clear` · `!status`

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
