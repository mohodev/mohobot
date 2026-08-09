# devtools - external AI debugging interface

Debug the AI path of MohoBot **without starting Discord**: fire a single prompt,
compare providers, watch a stream arrive, measure latency, and see exactly what
is registered in the runtime.

Two surfaces, one implementation:

| Surface | Entry point | Needs the runtime? |
|---|---|---|
| Chat commands (`!ai`, `!models`, `!diag`, `!bench`) | `index.ts` -> `ctx.registerCommand()` | yes (any gateway, console included) |
| Standalone CLI (`chat`, `stream`, `list`, `probe`) | `cli.ts` | no |

No file under `src/` was modified to add either one. The plugin registers its
commands through the documented `PluginContext`, and the CLI reuses the real
assembly path (`extensions/*.ts` -> `ConfigLoader` -> provider registry) instead
of shipping a second HTTP client.

**No API key required.** With `AI_API_KEY` empty the framework falls back to the
built-in offline `mock` provider, so every command below runs as-is.

---

## A. Chat commands

| Command | What it does |
|---|---|
| `!ai <prompt>` | One AI request that **bypasses session history**, prints reply + elapsed + token usage |
| `!models` | Providers currently in the registry, with their source, active one marked |
| `!diag` | Snapshot of all four registries + this bot's provider/model/adapter wiring |
| `!bench <n> <prompt>` | `n` sequential requests (hard cap 5): min/max/avg latency and success rate |

Every command is defensive: internal failures are caught and returned as text.
A broken provider produces `[ai] failed after 12ms - server http=503 ...`, never
an exception that could disturb the bot.

### Real run (console gateway, no credentials)

```bash
printf '!diag\n!models\n!ai hello from the runtime\n!bench 3 latency probe\n' \
  | MOHO_ADAPTER=console AI_API_KEY= timeout 25 npx tsx src/index.ts
```

```
[MohoBot] [diag] registries
  providers: echo-upper[extension:demo], kilo[plugin:kilo-provider], mock[builtin], openai-compatible[builtin]
  gateways : console[builtin], discord[builtin], webhook[extension:demo]
  storages : jsonl[extension:demo], memory[builtin], sqlite[builtin]
  memories : keyword[extension:demo], null[builtin]
[diag] bot
  id=main name=MohoBot adapter=console enabled=true
  ai.provider=openai-compatible ai.model=deepseek-chat baseUrl=https://api.deepseek.com/v1
  temperature=0.8 maxTokens=1024 timeoutMs=60000 retries=2
  apiKey=not set mockMode=yes
  memory.adapter=null session.scope=user disabledPlugins=[]
[diag] request headers (redacted)
  Content-Type: application/json | Authorization: Bearer [REDACTED] | User-Agent: mohobot-devtools
[MohoBot] [models] 4 registered, bot model=deepseek-chat
  echo-upper (source: extension:demo) - Shouts the user message back
  kilo (source: plugin:kilo-provider) - Kilo AI gateway (OpenAI-compatible, ...)
  mock (source: builtin) - Offline canned responses; used when no credentials are set <- active
  openai-compatible (source: builtin) - Any OpenAI-compatible /chat/completions endpoint
  note: running in MOCK mode (no API key)
[MohoBot] [ai] provider=mock model=mock:deepseek-chat 0ms (provider 0ms) finish=stop tokens prompt=6 completion=10 total=16
[mock] you said: hello from the runtime
[MohoBot] [bench] runs=3 ok=3 failed=0 success=100%
  latency min=0ms max=0ms avg=0.0ms
```

Note that `!diag` and `!models` also show entries registered by *other* plugins
and by `extensions/` - the registry is the single source of truth.

---

## B. Standalone CLI

```bash
npx tsx plugins/devtools/cli.ts <command> [options]
```

| Command | Purpose |
|---|---|
| `list` | every registered provider / gateway / storage / memory, plus configured bots |
| `chat --provider <name> --model <m> --prompt <text>` | one request: reply, finish reason, usage, elapsed |
| `stream --provider <name> --prompt <text>` | same, printing deltas as they arrive |
| `probe --provider <name>` | call `health()` and report |

Options: `--bot <id>`, `--model`, `--timeout <ms>`, `--show-headers`, `--json`,
`--verbose`, `-h/--help`. Argument parsing uses Node's built-in
`util.parseArgs` - no CLI dependency was added.

### `list`

```
root       : /home/workspace/Projects/mohobot
extensions : demo-extension.ts

providers (3)
  echo-upper           source=extension:demo - Shouts the user message back
  mock                 source=builtin - Offline canned responses; used when no credentials are set
  openai-compatible    source=builtin - Any OpenAI-compatible /chat/completions endpoint
gateways (3)
  console              source=builtin - stdin/stdout gateway for headless testing
  discord              source=builtin - Discord gateway (discord.js v14)
  webhook              source=extension:demo - Fake webhook platform
storages (3)
  jsonl                source=extension:demo - Append-only JSONL store
  memory               source=builtin - in-process Map store; nothing survives a restart
  sqlite               source=builtin - better-sqlite3 key/value store with WAL and TTL
memories (2)
  keyword              source=extension:demo - Remembers "my name is X"
  null                 source=builtin - no long-term memory (MVP default)

bots (1)
  main                 adapter=discord provider=openai-compatible model=deepseek-chat
```

### `chat`

```
$ npx tsx plugins/devtools/cli.ts chat --provider mock --prompt "hello"
provider : mock
model    : mock:deepseek-chat
prompt   : hello
--- reply ---
[mock] you said: hello
--- meta ---
finish   : stop
usage    : prompt 2 / completion 6 / total 8
elapsed  : 1ms (provider reported 1ms)
```

### `stream`

```
$ npx tsx plugins/devtools/cli.ts stream --provider mock --prompt "stream me please"
--- stream ---
[mock] you said: stream me please
--- meta ---
deltas   : 33 chars streamed
provider : mock
model    : mock:deepseek-chat
finish   : stop
usage    : prompt 4 / completion 9 / total 13
elapsed  : 0ms (provider reported 0ms)
```

### `probe`

```
$ npx tsx plugins/devtools/cli.ts probe --provider mock
provider : mock
model    : mock:deepseek-chat
health   : OK
detail   : mock provider - no network calls
elapsed  : 0ms

$ npx tsx plugins/devtools/cli.ts probe --provider nope        # exit code 1
error: Error: unknown provider "nope". Registered: echo-upper, mock, openai-compatible
```

An extension-provided provider works exactly the same way:

```
$ npx tsx plugins/devtools/cli.ts chat --provider echo-upper --prompt "extension path works"
provider : echo-upper
model    : deepseek-chat
--- reply ---
EXTENSION PATH WORKS
```

---

## Secrets never leave the process

- `onLoad` calls `registerSecret()` for the bot's API key and Discord token, so
  the logger masks them anywhere they might appear.
- Any header shown in debug output goes through `redactHeaders()`:
  `Authorization: Bearer sk-live-...` renders as `Authorization: Bearer [REDACTED]`.
  Other credential headers (`x-api-key`, `cookie`, ...) collapse to `[REDACTED]`.
- `!diag` reports `apiKey=set | not set` - never a prefix, length or hint.
- Unit tests lock this down, including a token short enough that the logger's
  generic pattern scrub would miss it, proving the masking is ours and not a
  lucky regex.

```
$ AI_API_KEY=sk-fake-secret-key-0123456789 npx tsx plugins/devtools/cli.ts \
    chat --provider mock --prompt "redaction check" --show-headers
...
headers  :
  Content-Type: application/json
  Authorization: Bearer [REDACTED]
  User-Agent: mohobot-devtools
```

---

## Tests and typecheck

The repo's root `vitest.config.ts` only includes `src/**/*.test.ts`, and the root
`tsconfig.json` excludes `plugins/` (its `rootDir` is `src`). Rather than edit
shared config, this plugin ships its own project files:

```bash
npx tsc -p plugins/devtools/tsconfig.json                       # 0 errors
npx vitest run --config plugins/devtools/vitest.config.ts       # 18 passed
```

```
 RUN  v2.1.9 /home/workspace/Projects/mohobot/plugins/devtools

 * devtools.test.ts (18 tests) 23ms

 Test Files  1 passed (1)
      Tests  18 passed (18)
```

All AI calls in the test suite use a fake provider with an injected clock - no
network, no credentials, no flakiness.

## Files

```
plugins/devtools/
  plugin.json        manifest (config.replyLimit)
  index.ts           Plugin default export; registers the four commands
  commands.ts        command implementations - pure functions, easy to test
  cli.ts             standalone CLI entry point
  devtools.test.ts   18 vitest cases (fake provider only)
  tsconfig.json      typecheck project for this plugin
  vitest.config.ts   test project for this plugin
  README.md          this file
```
