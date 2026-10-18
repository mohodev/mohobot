# MohoBot Agent Notes

MohoBot is a TypeScript ESM, Node.js >= 22.12 Discord AI runtime. It has no application framework.

## Commands

- `npm run dev` runs `src/index.ts` with `tsx watch`.
- `npm start` runs `app.js`, which loads compiled `dist/`; run `npm run build` after source changes or `npm start` will run stale code.
- `npm run typecheck` checks only `src/**/*.ts` and `scripts/setup.ts`.
- `npm test` runs `src/**/*.test.ts` with Vitest. Focus a test with `npx vitest run src/path/file.test.ts`.
- `npm run build` runs the broader build config (`src`, `plugins`, `extensions`) and copies plugin manifests; use it to verify plugin/extension TypeScript.
- `npm run scan-secrets` scans tracked files; `npm run scan-secrets -- --history` also scans added lines in git history.
- `npm run preflight` is the offline config, directory-write, and SQLite migration smoke test.
- `npm run setup -- --non-interactive` is idempotent setup; it creates `data/.env.local`, directories, admin token, and SQLite without overwriting an existing env file.
- `npm run acp` starts the ACP v1 stdio server.
- Plugin-specific checks use each plugin's own config, for example `npx vitest run --config plugins/operator/vitest.config.ts` and `npx tsc -p plugins/devtools/tsconfig.json`.
- The normal verification order is `npm run typecheck`, focused tests, `npm test`, `npm run scan-secrets`, `npm run preflight`, then `npm run build` when plugins/extensions changed.

## Test and Runtime Gotchas

- `vitest.setup.ts` gives every test file a throwaway `MOHO_ROOT`; preserve this isolation. Tests needing state must pass explicit `stateRoot`/`rootDir` rather than writing the repository's `data/`.
- Test timeout is 15 seconds. Do not use Jest flags such as `--runInBand`; Vitest does not support them.
- There is no lint or formatter configured. Do not add one; match surrounding style.
- Relative ESM imports must include `.js` even when the source file is `.ts`.
- `npm run typecheck` excludes `plugins/`, `extensions/`, and most scripts; use `npm run build` or the relevant plugin config for those paths.
- Hot reload is already in-process through `data/config`; do not add another watcher or `pm2 --watch`.

## Architecture Boundaries

- `discord.js` belongs only under `src/discord/`. Core types, pipeline policy, storage, memory, and AI code must remain platform-neutral.
- There are four extension registries: providers, gateways, storages, and memories. Unknown configured names degrade to safe built-ins; preserve this behavior instead of throwing on typos.
- `extensions/*.ts` auto-loads an exported `register`; `plugins/<id>/` loads through `plugin.json` and is reaped on unload. A new pipeline stage or event kind still requires a core `src/` change.
- `SessionManager` is the live model context. `ContextArchiver` is audit/archive storage and never feeds the model. Persisted sessions are record version 1 or 2; newer records are read-only/future data.
- Message processing is serialized per session. Direct DM/@/reply handling has higher priority than ordinary group participation; keep peer-bot privilege restricted to configured `discord.peerBots`.
- `MemoryStorage` is a test fixture, not a production storage driver. SQLite is the only built-in persistent driver.
- World/Device state currently uses `VersionedJsonStore` and is a documented SQLite migration debt; do not add new JSON persistence. See `REMAINING_WORK.md` and `docs/REVERSE_AUDIT_2026-10-18.md`.
- Expression Memory and Talk Governor are opt-in foundations. Expression Memory is separate from semantic exchange memory; Talk Governor is default-off and must not block direct summons.
- MCP is default-off. Model-initiated MCP calls use the fixed low-privilege `viewer` role and must pass MCP permission/audit checks. Operator and admin APIs are separate privilege planes.

## Data and Secrets

- Mutable runtime state belongs under `data/`: `data/config/`, `data/.env*`, prompts, SQLite, logs, caches, and generated state.
- Config precedence is schema defaults, provider files, global config, bot config, then environment variables; objects deep-merge, arrays/scalars replace.
- Secrets come only from environment (`data/.env`, `data/.env.local`, or process env). Never put keys in YAML, comments, logs, tests, or committed examples; use `${ENV_NAME}` placeholders where supported.
- `MOHO_COMPILED=1` makes runtime plugin/extension loading use `dist/` instead of source.

## Safe Operations

- Admin WebUI binds to `127.0.0.1:3210` and requires `MOHO_ADMIN_TOKEN` plus persistent storage.
- Write operations in the admin/control plane require RBAC and, for dangerous/reversible actions, confirmation and audit. Do not expose arbitrary shell, callbacks, Discord targets, or admin principals to model tools.
- Do not reset, checkout, or discard user changes. Do not edit runtime `data/` or rotate credentials unless explicitly requested.
- Production updates use the repository's guarded flow: `npm run check-update`, then authorized `npm run update`; it performs ff-only update, SQLite backup, setup, preflight, typecheck, test, and build. Do not start a second production process outside the managed service.

## References

- `README.md`: setup, configuration, deployment, and user-facing capabilities.
- `docs/ARCHITECTURE.md`: persona/control planes, storage boundaries, model pipeline, and trust model.
- `REMAINING_WORK.md`: current roadmap and explicit technical debt.
- `docs/REVERSE_AUDIT_2026-10-18.md`: code-derived feature inventory, incomplete integrations, and risks.
- `docs/EXTENDING.md`: extension contracts and credential gates.
- `docs/AUDIT.md`: verified risks, security decisions, and historical findings.
