# AGENTS.md

MohoBot: a long-running, multi-character Discord AI runtime. TypeScript ESM, no framework, Node ≥ 22.

## Commands

- `npm run dev` — run from source with reload. Use this while editing `src`/`plugins`/`extensions`.
- `npm start` — runs `node app.js`, which loads **compiled** `dist/`. Requires `npm run build` first; editing source then `npm start` runs stale code.
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — all Vitest suites.
- Single test: `npx vitest run src/<dir>/<name>.test.ts`.
- `npm run preflight` — offline config/dir-write/SQLite-migration check.
- `npm run setup -- --non-interactive` — creates `data/.env.local`, admin token, dirs, SQLite, and moves any pre-relocation `.env*`/`config/` files into `data/`. Idempotent; never overwrites an existing env.
- `npm run build` — `tsc -p tsconfig.build.json` into `dist/`, then copies each `plugins/*/plugin.json`.
- `npm run scan-secrets` — redacted credential scan of tracked files (`-- --history` adds every commit's added lines). `npm test` fails if a tracked file looks like it holds a credential; use `secretscan:ignore` on the line for a verified false positive. Known leaks in history are listed in `docs/AUDIT.md`.
- `npm run acp` — start the ACP (Agent Client Protocol) v1 server on stdio, so ACP-compatible editors can use MohoBot as an AI agent backend. Implements `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/delete`, `session/list`, `session/load`, `session/resume`, `session/close` with streaming `session/update` notifications.
- `opencode-cli` provider — drives the local `opencode run` CLI, reusing the signed-in OpenCode session (no API key needed). Set `AI_PROVIDER=opencode-cli` and `AI_MODEL=opencode/<model>` to use it. Defaults to the resident `opencode service` (one `--standalone` retry if that service is unusable).
- `emotion` (`src/emotion/`) — 好感度/亲密度/8 维情绪/关系阶段移植自 upstream `mohobot/emotion/`。Pre-LLM 注入语气块，回复后由后台 `task: admin` 二次分析（熔断 + 关键词降级），配置 `emotion.enabled` 默认 false；管理命令 `?好感度` / `?关系阶段` / `?好感排行`。Group gating is `decideSocially` (`src/pipeline/social-decision.ts`): mention/reply/DM always, room questions yes, chatter observed unless `social.proactiveParticipation`. Bot authors are second-class by design (`ignoreBots`, peer-bot cooldown, no direct privilege) — except `discord.peerBots` members, whose @/DM counts as a direct summon end to end (adapter filter → pipeline gate → social decision → interrupt → model-plan override).
- `personaAb` (`src/pipeline/persona-ab.ts`) — 私聊单轮人设 A/B 评估移植自 upstream `mohobot/services/persona_ab*.py`（persona_ab_card 的图片卡片改为 Discord 文本卡片，其余规则保留：同输入同参数、每记录洗牌、仅确认送达计数、投票不切换、中断不发送）。配置 `personaAb` 默认关闭；用户命令 `?ab` / `?ab A` / `?ab switch <id> A`，管理员 `?ab stats`。
- Discord 本土化移植（QQ 特性按平台重写）：`plugins/fun`（占卜/66 梗，关键词触发）、`plugins/welcome`（首见欢迎，无需特权 intent）、`plugins/bilibili`（BV/av 解析，公开 API 免 key）、`src/ai/usage.ts`（按调用类型 token 记账 + `?用量 [天数]` / `?用量 会话 [天数]` Top10，`task: 'ab'` 独立通道，`ChatOptions.channelId` 仅作记账线索）、`src/admin/broadcast.ts`（`?广播` 预告→确认两步扇出，只覆盖服务器不打扰私聊）。中文 `?` 别名（好感度/用量/广播…）在 `ADMIN_COMMAND_ALIASES` 统一归一化——之前中文命令根本到不了分发，已修。
- `operator` (`plugins/operator/`) — 运维 agent 框架（`plugin.json` 默认 `enabled:false`，Phase 0–4 完成）：管理命令 `?op diag|patch|config|restart|agent`（外加 `?op git` / `?op verify` / `?op confirm`，写操作一律二次确认），审计 API `GET /api/ops/operator-audit`（路由位 `audit.read`）。
- `?op agent <goal>` 是 ReAct 循环（最多 8 步），写操作先暂存成 pending 令牌再执行；工具实现与状态台账见 `plugins/operator/tools.ts`（`PLANNED_TOOLS` 里 `ready:true` 的项已落地）。
- Phase 5 剩余项按目录并行推进（`src/acp/**` / `webui/**` / `plugins/operator/*.test.ts` / `src/ai/**` 各占一目录），核心接线项须等并行件落地——清单见 `REMAINING_WORK.md`。
- 数据源跟着上游：搜索走 Anysearch MCP（`https://api.anysearch.com/mcp`，免 key 直通；配 `anysearchKey` 以备收紧）+ DuckDuckGo + Wikipedia 三后端链（`plugins/search`）；歌曲库走 VCPedia（分类分页 + 经典 revisions 取 wikitext，`rest.php` 在 Anubis 后面不碰），`src/songs/`（解析/匹配/同步）+ `scripts/sync-songs.ts` + `?同步歌曲`。
- `src/characters/` 除 CRUD（`catalog.ts`）外：角色互聊 `cross-chat.ts`（管理员驱动，轮转调度 + 硬回合上限 + 重复/超时熔断 + 沙箱 system prompt）与批量导入 `import.ts`（逐项校验/批内去重/dryRun/冲突 skip|overwrite/单项失败隔离），管理面 `POST /api/characters/cross-chat`、`POST /api/characters/import`。
- `src/mcp/`：MCP 工具权限 + 审计 + 真实 transport（stdio/http）+ `McpManager`（多 server、共享审计、失败隔离）；`src/ai/mcp-tools.ts` 将发现的 MCP 工具桥接进模型工具路径。**默认关闭**，config `mcp.enabled` 驱动（`docs/MCP.md`）；管理面 `GET /api/mcp/policy|tools|audit` + `POST /api/mcp/call`（二次确认）。被拒绝的调用到不了 transport，全部调用先脱敏写审计；模型调用固定使用 `viewer` 权限。
- `src/ai/tools.ts` + `src/pipeline/reply-filter.ts`（移植自 upstream `llm_tools.py` / `reply_filter.py`）：LLM function/tool-calling（`ChatToolRegistry` + `executeToolCall` + provider tools 支持 + pipeline 有界工具循环，`ai.tools.enabled` 默认关，allowlist + maxRounds，内置 `search_song`）；回复产物过滤器（剥 think/tool_call/format/voice 标签，流式安全、比较式不误伤、嵌套 drop、超长救援，`ai.replyFilter` 默认开）。

## Toolchain gotchas

- ESM with `NodeNext`: **relative imports must use the `.js` extension** even though the file is `.ts` (e.g. `import { X } from './loader.js'`).
- `tsconfig.json` only includes `src/**/*.ts` and `scripts/setup.ts`. `plugins/`, `extensions/`, and `scripts/{preflight,update,verify-*}.ts` are **not covered by `npm run typecheck`** — verify them via tests or the build config explicitly.
- Tests are co-located as `src/**/*.test.ts` (Vitest, 15s timeout). Note `src/setup.test.ts` and `src/update.test.ts` test `scripts/`; `update.test.ts` spins up real temp git repos and never calls the network.
- Tests are hermetic via `vitest.setup.ts`: every test file gets a throwaway `MOHO_ROOT` (cleaned in `afterAll`). Runtime state defaults to `MOHO_ROOT ?? process.cwd()` — notably `chatLogInsert()` opens `<root>/data/mohobot.db` when no `SqliteStorage` is attached — so without this, `npm test` wrote fake chat rows into the real database (and `npm run update` runs `npm test` inside the deployment) and parallel workers shared one WAL file, which intermittently killed a worker (`Worker exited unexpectedly`). New tests that drive the pipeline should rely on this setup and pass an explicit `stateRoot`/`rootDir` when they need a specific one.
- No lint or formatter is configured. Do not invent one; match surrounding style.
- Hot reload is in-process (`data/config/global.yaml` → `hotReload`). Don't add a filesystem watcher that would fight it, and don't use `pm2 --watch` (see `ecosystem.config.cjs`).

## Architecture constraints

- `discord.js` is confined to `src/discord/` (sole runtime importer is `client.ts`); `src/core/types.ts` deliberately imports no SDKs or `discord.js`.
- Exactly four extension registries — providers, gateways, storages, memories — selected by open-string config (`ai.provider`, `adapter`, `storage.driver`, `memory.adapter`). An unknown name degrades with a warning (unknown provider → `openai-compatible`, gateway → `console`, storage driver → `sqlite`); nothing crashes on a typo. SQLite is the only built-in storage driver (`MemoryStorage` remains purely a test fixture).
- Two extension paths: `extensions/*.ts` (auto-loaded at boot, export `register`) and `plugins/<id>/` (entry via `plugin.json`, auto-reaped on unload). Adding a new pipeline stage or event kind still requires editing `src/`.
- Message handling is serialized per session to keep AI replies ordered.
- Live model context is `SessionManager` (`src/session/manager.ts`), **not** `ContextArchiver` (audit-only JSONL archive that never feeds the model). Old turns are folded into a rolling LLM summary (`session.contextSummary`, background `summary` task lane) and injected by the pipeline as a system block; summarizer failure keeps the turns and the hard `maxMessages`/`maxChars` trim stays the fallback. Mock providers never get a summarizer.
- Persisted sessions are `recordVersion` 1 (plain) or 2 (carries a `summary`); anything newer is treated as read-only future data. Don't bump it without updating `src/session/codec.ts`.

## Config & secrets

- **Everything mutable lives under `data/`** — config (`data/config/`), env (`data/.env`, `data/.env.local`), prompts, DB, logs caches — so mounting `data/` alone survives a container rebuild. The loader still reads a pre-relocation `config/` / root `.env*` only when the `data/` copy is absent, and `npm run setup` migrates them.
- Precedence: schema defaults < `data/provider.yaml` < `data/provider.local.yaml` < `data/config/global.yaml` < `data/config/global.local.yaml` < `data/config/bots/*.yaml` < `data/config/bots/*.local.yaml` < env vars. Objects deep-merge; arrays/scalars replace.
- **Secrets only from env (`data/.env`/`data/.env.local` or process env).** Never put keys in YAML, comments, logs, or test fixtures. `data/provider.yaml` uses `${KILO_API_KEY}` placeholders.
- `*.local.yaml` and `.env*` are gitignored; runtime DB/logs/caches under `data/` are gitignored except versioned examples/prompts/config.
- `data/provider.yaml` default is `kilo` / `tencent/hy3:free`; a comment there says not to silently switch the deployed model.
- `MOHO_COMPILED=1` (set by `app.js`) makes the runtime load plugins/extensions from `dist/` instead of source.

## Offline smoke test

Fully exercises the NL pipeline with no credentials:

```bash
printf 'hello\n' | MOHO_ADAPTER=console AI_API_KEY= npx tsx src/index.ts
```

## Operations

- Admin WebUI defaults to `127.0.0.1:3210`, login with `MOHO_ADMIN_TOKEN`; only starts when a token and persistent storage exist.
- Production updates: `npm run check-update` (offline, no fetch) then `npm run update` (ff-only, SQLite backup, `npm ci` → setup → preflight → typecheck → test → build). It never `reset`s; a stuck `.mohobot-update.lock/` must be removed manually after confirming no updater runs.
- Security history: a real-looking Kilo token was committed and removed from the worktree but may persist in git history. Treat any leaked key as compromised and rotate.

## References

- `docs/EXTENDING.md` — extension points, `needsKey` credential gate, what still requires core edits.
- `docs/ARCHITECTURE.md` — persona/control planes, SQLite-only storage layering, model task types.
- `docs/AUDIT.md` — verified baseline and known open risks (plugin timeout limits, admin permission model).
