# MohoBot

> 可长期运行、可扩展、故障隔离的 Discord AI Runtime。

MohoBot 当前已经具备：Discord/Console 网关、OpenAI-compatible 多供应商路由、SQLite 会话持久化（唯一存储驱动）、Embedding/Rerank 语义记忆、世界/设备/关系状态、插件热加载、多 Bot、运行监督、管理 WebUI 和首次启动向导。

> **状态说明：** 存储只保留 SQLite——MySQL/Redis/Kafka 镜像与 Outbox 已整体移除（需要时可由插件注册新的存储驱动）。模型目录是动态参考快照，不把 NVIDIA Free Endpoint 数量写死。详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/IMMERSION.md`](docs/IMMERSION.md) 与 [`docs/AUDIT.md`](docs/AUDIT.md)。

## 快速开始

```bash
npm install
npm run setup -- --non-interactive
# 编辑 data/.env.local：DISCORD_TOKEN 和所选 Provider 的 API Key
npm start
```

首次启动向导会创建 `data/.env.local`、随机管理员 Token、运行目录和 SQLite；已有 `.env.local` 不会被覆盖，根目录遗留的 `.env*` 与 `config/` 会被自动迁移到 `data/`。管理 WebUI 默认在 `127.0.0.1:3210`，使用 `MOHO_ADMIN_TOKEN` 登录。

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
3. 根据 `MOHO_STORAGE_PATH` / `data/.env.local` / `data/config/global.yaml` 定位 SQLite；
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

所有可变文件都集中在 `data/`（配置 `data/config/`、环境变量 `data/.env*`、提示词、数据库、日志缓存），因此容器部署只需挂载 `data/` 一个卷即可在重建后保留全部状态；根目录的 `.env*` 与 `config/` 只在 `data/` 对应文件缺失时才被读取，`npm run setup` 会主动迁移它们。

优先级：Schema 默认值 < `data/provider.yaml` < `data/provider.local.yaml` < `data/config/global.yaml` < `data/config/global.local.yaml` < `data/config/bots/*.yaml` < `data/config/bots/*.local.yaml` < 环境变量。

`*.local.yaml` 用于机器私有覆盖并已加入 `.gitignore`。对象会递归合并，数组和标量整体替换；例如 `data/config/bots/main.local.yaml` 只覆盖 `main.yaml`，不会被加载成第二个 Bot。旧配置文件无需改名，`version` 字段可选。可从 `data/config/global.local.example.yaml` 复制所需结构。

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

`data/config/global.yaml` 保存可跟踪的运行参数；`data/provider.yaml` 保存可跟踪的 Provider 默认项；对应的 `.local.yaml` 只放机器差异，仍不得写入密钥（密钥只从环境变量读取）。新版本增加的未知字段在旧版运行时只会告警并忽略，不会阻断启动。NVIDIA Build/NIM 模型目录仅作动态参考，启用前需按当前账号做健康检查。

**上下文摘要：** `session.contextSummary`（全局或单 Bot，深合并）默认开启——会话变长时，最旧的若干轮会被 LLM 折叠为一份滚动摘要，并在下一次回复时作为系统消息注入，而不是被直接丢弃；摘要失败时保留原文，`mock` 提供方不会启用。完整字段、触发规则与回滚方式见 [`docs/CONTEXT_SUMMARY_MIGRATION.md`](docs/CONTEXT_SUMMARY_MIGRATION.md)。设 `enabled: false` 即恢复旧行为。

存储只有 SQLite 一个驱动（`storage.driver: sqlite`，默认值）；`memory`/MySQL/Redis/Kafka 等其它存储选项已删除，未知驱动名会降级为 SQLite 并告警。`storage.path` 默认 `./data/mohobot.db`，备份目录 `data/backups/`。

## ACP (Agent Client Protocol)

MohoBot 内置 ACP v1 server，可让任何 ACP 兼容编辑器（Zed、VS Code、JetBrains、Avante.nvim 等）把 MohoBot 作为 AI agent 后端使用。

```bash
npm run acp
# 或
npx tsx src/acp/index.ts
```

编辑器配置示例（Zed `~/.config/zed/settings.json`）：

```json
{
  "agent_servers": {
    "MohoBot": {
      "command": "npx",
      "args": ["tsx", "src/acp/index.ts"]
    }
  }
}
```

支持的方法：`initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/delete`、`session/list`、`session/load`、`session/resume`、`session/close`。流式响应通过 `session/update` 通知推送。

## OpenCode CLI Provider

MohoBot 内置 `opencode-cli` provider，通过子进程调用 `opencode run`，复用当前 OpenCode 登录态，无需 API key。

```yaml
# data/provider.yaml
provider: opencode-cli
model: opencode/ling-3.1-flash-free
temperature: 0.8
options:
  bin: opencode
  timeoutMs: 180000
```

默认复用在后台常驻的 `opencode service`（每次调用省 3–4 秒私有 server 冷启动）；服务不可用时自动回退一次 `--standalone`。若要保持完全隔离：

```yaml
options:
  standalone: true
```

## 好感度与关系阶段

移植自 [`CarefreeSongs712/mohobot`](https://github.com/CarefreeSongs712/mohobot) 的 `mohobot/emotion/`（astrbot-plugin-emotionai_pro）。默认关闭，开启后每次回复会由第二次 LLM 调用给这段关系打分，并在下一次回复前注入语气引导：

- **好感度**（-100~100）与**亲密度**（0~100）
- **8 维情绪**（喜悦/信任/恐惧/惊讶/悲伤/厌恶/愤怒/期待），只用于语气
- **关系阶段**：初识 → 深化 → 承诺 → 共生；负好感走冷淡/反感/敌对三条修复线。升阶段吃满阈值，掉阶段要低于阈值 5 点（滞后带，一条坏消息不会让关系立即掉级）
- 首次互动、情绪关键词、久未更新、每 N 轮强制分析四种触发；轮次冷却 + 最小时间间隔双闸门
- 分析用 LLM 连续失败 3 次后熔断 5 分钟，改走关键词降级——**模型偶发故障不会让好感度系统变成错误来源**

```yaml
# data/config/bots/main.yaml
emotion:
  enabled: true
```

启用后在管理端（`?`，仅管理员 Bot 的授权用户）：

| 命令 | 说明 |
|---|---|
| `?好感度 [用户ID]` | 好感/亲密/阶段/主导情感/态度/互动统计 |
| `?关系阶段 [用户ID]` | 阶段、复合评分、下一阶段阈值与进度、进阶建议 |
| `?好感排行 [条数]` | 加权综合分排行 |
| `?设好感 <用户ID> <数值>` / `?设亲密 <用户ID> <数值>` | 手动设置 |

数据落在 `<root>/data/emotion/<botId>/user_states.json` 与 `memory.json`（仅显著互动入库，每用户上限 50 条），由任务系统每分钟批量落盘，关闭时也会兜底 flush。

## 人设 A/B 评估（prompt beta 测试）

移植自上游 `mohobot/services/persona_ab{,_repository}.py`。私聊按概率触发：同一输入、同一模型参数，只换人设各生成一版，匿名展示 A / B 供投票，用于在生产环境对比测试版提示词：

- baseline 缺省 = 当前线上人格；test = `testPromptFile` 指定的 beta
- 只有确认送达的卡片才计一次曝光；失败降级为普通单回复，不计数
- 投票不切换人设；`?ab switch <编号> A/B` 才绑定偏好（聊天记录保留）
- 被新消息打断的评估不发送任何东西、不计入统计

```yaml
# data/config/bots/main.yaml
personaAb:
  enabled: true
  testPromptFile: data/prompts/天依测试.txt
  probability: 0.05
```

用户命令（私聊）：`?ab`（待投票状态）· `?ab A/B/平局/都不好/跳过`（投票）· `?ab switch <编号> A`（切换）。管理员：`?ab stats`（胜负统计）。数据落在 `<root>/data/persona-ab/<botId>/`（原子写，无需 flush 任务）。

## 用量统计与广播

每次模型调用都会按任务通道记账（主回复/上下文总结/后台分析/人设对比/视觉识别），数据落在 SQLite（`usage:<bot>:<日期>:<通道>`），读侧永远不抛错：

| 命令（管理员） | 说明 |
|---|---|
| `?用量 [天数]` | 近 N 天分通道统计（默认 1 天，最多 30 天）：次数 / 输入 / 输出 tokens + 总计 |
| `?同步歌曲` | 后台同步 VCPedia 新歌（约十几分钟），完成后在当前频道通知 |

`?广播 <内容>` 是两步走的服务器广播（Discord 没有 QQ 好友列表可枚举，只覆盖 bot 能看到的服务器，每个服发到首个文字频道；私聊不打扰）：先 `?广播 <内容>` 预告（预览发到管理日志频道），10 分钟内 `?广播确认` 才真正扇出，`?广播取消` 撤销。结果（含失败服）会汇总回管理频道。

## 歌曲库（VCPedia）

上游 `mohobot/music_knowledge/` 的数据源和字段原样跟随：VCPedia 分类全量分页 + 经典 `revisions` 接口取 wikitext（`rest.php` 在 Anubis 后面，不碰），解析 Songbox（演唱/UP主/词曲编混调/PV/曲绘/BV 号）+ `<poem>` 歌词，存 SQLite kv。聊天里提到歌名（`《》`最高置信）或歌词片段时，自动注入【歌曲信息】块（介绍 + 制作名单 + 全文歌词），只进本次请求不写上下文：

```bash
npx tsx scripts/sync-songs.ts --limit=50  # 先小批量冒烟
npx tsx scripts/sync-songs.ts             # 全量（约 4000 首，十几分钟）
```

`?同步歌曲`（管理员）后台同步，完成后在当前频道通知。`?用量` 同理。配置：

```yaml
# data/config/bots/main.yaml
songs:
  enabled: true
```

## 趣味与迎新插件

`plugins/` 下开箱即用（`plugin.json` 关掉即可），全部走 Discord 原生行为：

| 插件 | 行为 |
|---|---|
| `fun` | `占卜` / `/占卜` / `今日占卜` 每日一签（每人每天一次，不耗模型）；群里 `6` / `66` / `666` 20% 概率接梗 |
| `welcome` | 首次发言的用户按服务器欢迎一次（不吞消息，照常回复）；不用特权 intent |
| `bilibili` | 消息里的 BV/av 链接回一条标题/作者/时长卡片；直连 api.bilibili.com 在部分机房会被 412 风控，此时静默跳过（可配 `apiUrl` 指向自建解析服务） |

### 群消息策略

`social` 控制"没人叫它时说不说话"（默认只听不说）：

| 场景 | 行为 |
|---|---|
| 被 @ / 引用回复 / 私聊 | 一定回复 |
| 白名单里的 RP 角色插嘴 | 回复（连续 3 次后冷却） |
| 群里有人提问 | 回复（连答 6 次后收声） |
| 寒暄/附和/普通陈述 | 只观察，不说话 |
| `social.proactiveParticipation: true` | 按概率主动插话（默认 16%，受精力/压力调节） |

## 预制提示词

`data/prompts/` 下已导入 14 个来自 [`CarefreeSongs712/vc-character-prompt`](https://github.com/CarefreeSongs712/vc-character-prompt) 的预制提示词（commit `b932b68`），覆盖 12 位虚拟歌手角色（天依、初音未来、墨清弦、乐正绫、言和、心华、星尘、诗岸、摩柯、海伊、赤羽、龙牙）及 1 个图片识别提示词。这些文件可直接作为 `systemPromptFile` 使用，或作为角色 Bot 的预设提示词导入。引用记录见 `data/admin/prompt-source-vc.json`。

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

**封禁：** 管理 Bot 的授权管理员可用 `?ban <用户ID或@> [时长] [原因]`、`?unban <用户ID或@>`、`?banlist`（时长如 `30m` / `2h` / `1d2h`，不写为永久；加 `--here` 只作用于当前频道）。被封禁用户会被静默忽略（不是 Discord 服务器封禁），封禁持久化在 SQLite 并按时长自动失效；管理员自身不会被封禁，也不能封禁自己或已配置的管理员。非管理员发送这些命令不会有任何回应。

**噪声过滤：** `repeatGuard`（每个 Bot，默认开启）会静默忽略以 `[自动回复]` 开头的消息，以及同一发送者在 `windowMs`（默认 5 分钟）内连续 `maxRepeats`（默认 3）次发送相同文本——可挡住刷屏、卡住的客户端，以及白名单对端 Bot 之间互相复读的死循环。管理员不受影响；设 `repeatGuard.enabled: false` 关闭。

角色 Bot 不执行 `!` 文本命令。普通 Bot 不注册管理 Slash；墨染荷韵仅对授权管理员注册 `/status`，并支持 WebUI 管理入口。插件命令只能通过经过鉴权的 Interaction 或管理面板触发。

## 安全提示

仓库曾提交过疑似真实 Kilo Token。当前工作树已移除，但 Git 历史中的值不会因普通删除而消失：必须在 Kilo 后台撤销并轮换，然后按团队策略清理 Git 历史与缓存副本。

可用 `npm run scan-secrets`（加 `-- --history` 扫描历史）本地检查凭据泄漏，输出已脱敏；`npm test` 也会拦截被跟踪文件中的凭据形状值。2026-10 复查的具体发现与待办见 [`docs/AUDIT.md`](docs/AUDIT.md)。

## 路线图

1. 管理 API + 鉴权 + 只读状态面板
2. 角色模型与角色 CRUD / 导入
3. 可检索长期记忆实现与管理
4. 测试聊天、角色互聊
5. 行为引擎、世界状态与事件
6. MCP 工具权限与审计

不要把规格页当成功能实现；每一阶段必须有 API、UI、权限边界和自动化测试闭环。
