# Extending MohoBot without touching `src/`

MohoBot has exactly **four extension points**. Everything the runtime picks at
boot is resolved through a registry, never through an `if/else` in runtime code.

| Registry | Adds | Selected by |
|---|---|---|
| `providers` | AI backends | `bots/<id>.yaml` -> `ai.provider` |
| `gateways` | Chat platforms | `bots/<id>.yaml` -> `adapter` |
| `storages` | Persistence drivers | `global.yaml` -> `storage.driver` |
| `memories` | Long-term memory | `bots/<id>.yaml` -> `memory.adapter` |

## The proof, not the promise

`extensions/demo-extension.ts` adds a new AI provider, gateway, storage driver
and memory adapter in one file. `scripts/verify-extensibility.ts` exercises all
four and asserts `src/` stays **byte-identical**:

```bash
npx tsx scripts/verify-extensibility.ts
```

```
PASS  new AI provider via config  -> "HELLO EXTENSION"
PASS  new gateway via config  platform=webhook inbound=["ping from webhook"]
PASS  new storage driver via config  file={"key":"k1","value":{"hello":"jsonl"}...
PASS  long-term memory recall after context cleared  context=["SYSTEM","Known facts about this user: name=Pi"]
PASS  plugin extensions reaped on unload  reaped=["temp-plugin-provider"]
PASS  built-ins still present  providers=echo-upper,mock,openai-compatible gateways=console,discord,webhook

EXTENSIBILITY_PROVEN
```

SHA-256 of every non-test file under `src/`, before and after that run:
`57a37d299c3ead2823db9ecc4e6cb2dc4ced16a19ef80dfe11bf4c5b1b8c7d6d` - unchanged.

`src/core/registry.test.ts` locks the behaviour in so a future `if/else`
regression fails CI.

## Two ways to register

### 1. An `extensions/*.ts` module

Auto-loaded at boot, before any bot starts. Export `register`:

```ts
// extensions/my-llm.ts
import type { Registries } from '../src/core/registries.js';
import type { Logger } from '../src/core/logger.js';

export function register(registries: Registries, logger: Logger): void {
  registries.providers.register('my-llm', (cfg, deps) => new MyProvider(cfg, deps), {
    source: 'extension:my-llm',
    description: 'Talks to my in-house model server',
  });
}
```

A broken extension is logged and skipped - it never blocks boot.

### 2. From a plugin's `onLoad`

```ts
export default {
  name: 'telegram-bridge',
  onLoad(ctx) {
    ctx.registry.gateways.register('telegram', (cfg, deps) => new TelegramGateway(cfg, deps));
  },
};
```

Plugin registrations are **auto-tagged** with `plugin:<id>` and **auto-reaped**
on unload, so hot reload cannot leak dead factories or hit "already registered".

## Interfaces to implement

```ts
// AI provider           - src/ai/types.ts
interface AIProvider { name; model; chat(messages, options); health(); }

// Gateway               - src/discord/types.ts
interface Gateway { platform; name; start(); stop(); onMessage(h); send(out); status(); }

// Storage driver        - src/storage/types.ts
interface Storage { init(); save(); get(); delete(); query(); close(); ready; }

// Memory adapter        - src/storage/types.ts
interface MemoryAdapter { name; recall(input); remember(input); }
```

## Declaring a vendor-specific credential (needsKey)

By default the runtime treats a provider as unusable (and falls back to mock)
when `ai.apiKey` is empty. That is wrong for a plugin whose key lives in its
own env var (e.g. `KILO_API_KEY`, `NVIDIA_NIM_API_KEY`).

Register the factory with a `needsKey` hook so the credential gate delegates to
YOUR provider instead of the shared `AI_API_KEY`:

```ts
function kiloNeedsKey(cfg: { apiKey?: string }): boolean {
  const fromConfig = typeof cfg.apiKey === 'string' && cfg.apiKey.trim() !== '';
  const fromEnv = typeof process.env.KILO_API_KEY === 'string' && process.env.KILO_API_KEY.trim() !== '';
  return !fromConfig && !fromEnv;
}

ctx.registry.providers.register('kilo', factory, {
  source: 'plugin:kilo-provider',
  needsKey: kiloNeedsKey,
});
```

Now a bot that sets `KILO_API_KEY` (and leaves `AI_API_KEY` unset) runs the
real `kilo` provider - no mock, no core edit. This is the mechanism you use
when you later add NVIDIA NIM as a fallback: register it with its own
`needsKey: (c) => !c.apiKey && !process.env.NVIDIA_NIM_API_KEY` and select it
via `ai.provider: nim`. The multi-channel / fallback wiring lives in config,
not in runtime source.

## Config is open, not enum-locked

`ai.provider`, `adapter`, `storage.driver` and `memory.adapter` are **open
strings**. Registering `postgres` makes `driver: postgres` valid immediately -
no schema edit. Each block also carries a passthrough `options` record for
driver-specific settings, and bots have an `extra` record for third-party
gateway credentials.

An unknown name **degrades with a warning** instead of crashing: unknown
provider -> `openai-compatible`, unknown gateway -> `console`, unknown driver ->
`memory`. A config typo can never take the runtime down.

## Plugin config actually works

`plugin.json` -> `config` is delivered as a frozen `ctx.config`:

```json
{ "name": "ping", "version": "1.0.0", "config": { "reply": "pong!" } }
```

```ts
onLoad(ctx) {
  this.reply = (ctx.config.reply as string) ?? 'pong';
  ctx.logger.info({ model: ctx.botConfig.ai.model }, 'bot config is readable too');
}
```

## What still requires core changes

Honest boundaries - these are *not* covered by the four registries:

- **New pipeline stages.** Plugins hook `onMessage` / `onBeforeAI` / `onAfterAI`.
  A genuinely new stage means editing `src/pipeline/pipeline.ts`.
- **New event types.** Adding a Moho event kind touches `src/core/types.ts`.
- **Non-chat surfaces** (HTTP API, WebUI) - deliberately out of MVP scope.

Everything on the stated roadmap - Memory Layer, Agent Layer, MCP, new
platforms, new databases - fits the existing extension points. Future provider
credentials no longer need core changes.
