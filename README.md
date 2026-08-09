# MohoBot

> A stable, long-running Discord AI Runtime. Engine first, cockpit later.

MVP scope: Discord connects, AI replies, plugins extend, errors stay contained,
crashes recover, config hot-reloads. No WebUI, no Agent framework, no vector DB.

## Quick start

```bash
npm install
cp .env.example .env      # fill in DISCORD_TOKEN and AI_API_KEY
npm start
```

No credentials? The runtime still boots — it falls back to the **console gateway**
(stdin/stdout) and the **mock AI provider**, so the whole pipeline is testable offline:

```bash
printf 'ping\n!help\nhello\n' | MOHO_ADAPTER=console AI_API_KEY= npx tsx src/index.ts
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the runtime (tsx, no build step) |
| `npm run dev` | Same, with watch-restart |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | vitest, 148 tests |
| `npm run build` | Emit `dist/` |
| `npx tsx scripts/verify-hotreload.ts` | Prove plugin hot reload works under the real runtime |
| `npx tsx scripts/verify-extensibility.ts` | Prove new provider/gateway/storage/memory need zero `src/` changes |

## Extending without touching the core

Four registry-backed extension points - AI providers, gateways, storage drivers,
memory adapters - configured by open string names, never by an enum or an
`if/else` in runtime code. Register from `extensions/*.ts` or from a plugin's
`onLoad`; plugin registrations are auto-reaped on unload.

See **[docs/EXTENDING.md](docs/EXTENDING.md)** - it includes a machine-checked
proof that `src/` stays byte-identical while four new capabilities are added.

## Architecture

```
                Supervisor            <- lifecycle, restart, error isolation
         |----------|----------|
    BotRuntime  PluginMgr  TaskManager
         |
   Discord Gateway   <- the ONLY module importing discord.js
         |
   Message Pipeline  <- guards -> plugins -> commands -> session -> AI -> send
         |
     AI Provider     <- OpenAI-compatible, timeout + retry + streaming
         |
       Storage       <- SQLite today, same interface for Postgres/Redis later
```

Design rules that are enforced, not aspirational:

- **No module outside `src/discord/` imports discord.js.** Discord events are
  translated into `MohoMessage` / Moho events at the boundary. Swapping the
  gateway later touches one directory.
- **Nothing below the Supervisor may kill the process.** Plugin throws, AI
  failures, gateway drops, unhandled rejections — all logged and contained.
- **No bare `setInterval` / floating promises.** Background work goes through
  `TaskManager.spawn()`, which tracks, times out, and cancels it.
- **Secrets never reach a log sink.** `registerSecret()` + pino redaction mask
  tokens structurally and textually, including inside error messages.

### Layout

```
src/
  core/       types, event bus, logger, supervisor, task-manager, hot-reload
  config/     zod schema + yaml/env loader
  discord/    gateway (discord.js), adapter (pure translation), console gateway
  ai/         provider contract, OpenAI-compatible impl, mock provider
  session/    short-term context, MemoryAdapter hook for the future
  plugins/    plugin contract + isolating manager
  pipeline/   the single inbound message path
  bot/        BotRuntime - one self-contained bot
  storage/    Storage interface, SQLite + memory drivers
  index.ts    boot, wiring, signals, graceful shutdown
config/
  global.yaml       runtime-wide settings
  bots/main.yaml    one file per bot
plugins/
  ping/             reference plugin
```

## Configuration

YAML holds behaviour, env holds secrets. Env always wins.

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | Bot token (per-bot form: `MOHO_BOT_<ID>_DISCORD_TOKEN`) |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | AI provider (per-bot form: `MOHO_BOT_<ID>_AI_API_KEY`) |
| `MOHO_ADAPTER` | `discord` or `console` |
| `LOG_LEVEL` | pino level |
| `MOHO_STORAGE_PATH` | Override the SQLite path |

A token found in YAML is accepted but logged as a warning telling you to move it.

**Hot reload:** edit `config/*.yaml` and only the bots whose config actually
changed restart. Edit `plugins/<id>/` and just that plugin reloads. A failed
reload keeps the previous version running — verified, not assumed.

## Multi-bot

Drop another file in `config/bots/`:

```yaml
# config/bots/second.yaml
id: second
name: SecondBot
ai:
  model: gpt-4o-mini
```

Each bot gets its own gateway, provider, sessions, plugin manager and pipeline,
and is supervised independently. `MOHO_BOT_SECOND_DISCORD_TOKEN` supplies its token.

## Writing a plugin

```ts
// plugins/hello/index.ts
import type { Plugin } from '../../src/plugins/types.js';

const plugin: Plugin = {
  name: 'hello',
  onLoad(ctx) {
    ctx.registerCommand({ name: 'hi', execute: () => 'hey!' });
  },
  onMessage(message) {
    if (message.content === 'ping') return { stop: true, reply: 'pong' };
  },
};
export default plugin;
```

Hooks: `onLoad` / `onUnload` / `onMessage` / `onBeforeAI` / `onAfterAI`.
Every hook is timeout-guarded; a plugin that fails `maxErrors` times in a row is
disabled while the bot keeps serving. Plugins get namespaced storage and can
never see a raw discord.js object or the shared database.

## Built-in commands

`!help` · `!reset` (clear context) · `!status` (runtime stats)

## What is deliberately NOT here

WebUI, dashboard, Agent system, long-term memory, vector DB, MCP, voice, vision.
The extension points exist (`MemoryAdapter`, `Storage`, `Plugin`) so adding them
later does not require a rewrite.

## Roadmap

```
Runtime -> Plugin -> Stability -> Memory -> Agent -> WebUI
```

Phases 1–3 (basic run, extensibility, stability) are implemented.
