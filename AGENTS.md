# AGENTS.md

MohoBot: a long-running, multi-character Discord AI runtime. TypeScript ESM, no framework, Node ≥ 22.

## Commands

- `npm run dev` — run from source with reload. Use this while editing `src`/`plugins`/`extensions`.
- `npm start` — runs `node app.js`, which loads **compiled** `dist/`. Requires `npm run build` first; editing source then `npm start` runs stale code.
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — all Vitest suites.
- Single test: `npx vitest run src/<dir>/<name>.test.ts`.
- `npm run preflight` — offline config/dir-write/SQLite-migration check.
- `npm run setup -- --non-interactive` — creates `.env.local`, admin token, dirs, SQLite. Idempotent; never overwrites an existing env.
- `npm run build` — `tsc -p tsconfig.build.json` into `dist/`, then copies each `plugins/*/plugin.json`.
- `npm run scan-secrets` — redacted credential scan of tracked files (`-- --history` adds every commit's added lines). `npm test` fails if a tracked file looks like it holds a credential; use `secretscan:ignore` on the line for a verified false positive. Known leaks in history are listed in `docs/AUDIT.md`.

## Toolchain gotchas

- ESM with `NodeNext`: **relative imports must use the `.js` extension** even though the file is `.ts` (e.g. `import { X } from './loader.js'`).
- `tsconfig.json` only includes `src/**/*.ts` and `scripts/setup.ts`. `plugins/`, `extensions/`, and `scripts/{preflight,update,verify-*}.ts` are **not covered by `npm run typecheck`** — verify them via tests or the build config explicitly.
- Tests are co-located as `src/**/*.test.ts` (Vitest, 15s timeout). Note `src/setup.test.ts` and `src/update.test.ts` test `scripts/`; `update.test.ts` spins up real temp git repos and never calls the network.
- No lint or formatter is configured. Do not invent one; match surrounding style.
- Hot reload is in-process (`config/global.yaml` → `hotReload`). Don't add a filesystem watcher that would fight it, and don't use `pm2 --watch` (see `ecosystem.config.cjs`).

## Architecture constraints

- `discord.js` is confined to `src/discord/` (sole runtime importer is `client.ts`); `src/core/types.ts` deliberately imports no SDKs or `discord.js`.
- Exactly four extension registries — providers, gateways, storages, memories — selected by open-string config (`ai.provider`, `adapter`, `storage.driver`, `memory.adapter`). An unknown name degrades with a warning (unknown provider → `openai-compatible`, gateway → `console`, driver → `memory`); nothing crashes on a typo.
- Two extension paths: `extensions/*.ts` (auto-loaded at boot, export `register`) and `plugins/<id>/` (entry via `plugin.json`, auto-reaped on unload). Adding a new pipeline stage or event kind still requires editing `src/`.
- Message handling is serialized per session to keep AI replies ordered.
- Live model context is `SessionManager` (`src/session/manager.ts`), **not** `ContextArchiver` (audit-only JSONL archive that never feeds the model). Old turns are folded into a rolling LLM summary (`session.contextSummary`, background `summary` task lane) and injected by the pipeline as a system block; summarizer failure keeps the turns and the hard `maxMessages`/`maxChars` trim stays the fallback. Mock providers never get a summarizer.
- Persisted sessions are `recordVersion` 1 (plain) or 2 (carries a `summary`); anything newer is treated as read-only future data. Don't bump it without updating `src/session/codec.ts`.

## Config & secrets

- Precedence: schema defaults < `data/provider.yaml` < `data/provider.local.yaml` < `config/global.yaml` < `config/global.local.yaml` < `config/bots/*.yaml` < `config/bots/*.local.yaml` < env vars. Objects deep-merge; arrays/scalars replace.
- **Secrets only from env (`.env`/`.env.local` or process env).** Never put keys in YAML, comments, logs, or test fixtures. `data/provider.yaml` uses `${KILO_API_KEY}` placeholders.
- `*.local.yaml` and `.env.local` are gitignored; runtime DB/logs/caches under `data/` are gitignored except versioned examples/prompts.
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
- `docs/ARCHITECTURE.md` — persona/control planes, SQLite/MySQL/Redis layering, model task types.
- `docs/AUDIT.md` — verified baseline and known open risks (plugin timeout limits, admin permission model).
