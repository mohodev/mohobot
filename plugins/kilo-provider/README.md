# kilo-provider

Adds the **`kilo`** AI provider to MohoBot: the Kilo gateway, an OpenAI-compatible
endpoint that fronts ~349 models (10 of them free).

This is a **plugin**. Nothing under `src/` was changed to make it work - it hooks
the `providers` registry from `onLoad`, exactly as `docs/EXTENDING.md` promises.

```
plugins/kilo-provider/
  plugin.json        manifest + tunables (baseUrl, defaultModel, maxTokens, ...)
  index.ts           registers the factory as `kilo`
  provider.ts        KiloProvider implements AIProvider
  provider.test.ts   vitest, 100% injected fetch, no network
  tsconfig.json      the root tsconfig excludes plugins/ - this type-checks it
  vitest.config.ts   the root vitest config globs src/ only - this runs these tests
```

## Enable it

1. Put the key in the environment - **never in a file**:

   ```bash
   export KILO_API_KEY=...            # or AI_API_KEY / MOHO_BOT_<ID>_AI_API_KEY
   ```

2. Point a bot at it (`bots/<id>.yaml`):

   ```yaml
   ai:
     provider: kilo               # open string, resolved through the registry
     model: tencent/hy3:free
     maxTokens: 2048              # see the token-budget trap below
     # baseUrl / timeoutMs / retries are optional - plugin defaults cover them
   ```

That is the whole integration. `provider: kilo` becomes valid the moment the
plugin loads; no schema edit, no `if/else` in the runtime.

## Endpoint

| | |
|---|---|
| Base URL | `https://api.kilo.ai/api/gateway/v1` |
| Chat | `POST /chat/completions` |
| Models | `GET /models` -> `{ data: [{ id, name, ... }] }` |
| Auth | `Authorization: Bearer $KILO_API_KEY` |

## Configuration precedence

Highest wins:

1. `ai.options.<key>` in the bot yaml (passthrough block - always explicit)
2. `ai.<key>` in the bot yaml, **when it differs from the framework default**
3. `plugin.json` -> `config`
4. the built-in Kilo defaults

| key | plugin default | note |
|---|---|---|
| `baseUrl` | `https://api.kilo.ai/api/gateway/v1` | |
| `defaultModel` | `tencent/hy3:free` | `ai.model` overrides |
| `maxTokens` | `2048` | deliberately above the framework's 1024 |
| `temperature` | `0.8` | |
| `timeoutMs` | `90000` | reasoning models are slow |
| `retries` | `2` | timeout / network / 5xx / 429 only |
| `retryBaseDelayMs` | `500` | exponential backoff with +-20% jitter |
| `stream` | `false` | streaming needs `onDelta` too |

The API key is **never** read from `plugin.json`. It comes from `ai.apiKey`
(env-injected by the config loader) or straight from `KILO_API_KEY`.

## The three traps this provider absorbs

### 1. Reasoning models eat the token budget

`tencent/hy3:free` is a reasoning model. The response carries the chain of
thought in `message.reasoning`, and `message.content` can be **`null`**.

Measured on the live gateway:

| request | result |
|---|---|
| `max_tokens: 20` | `content: null`, `finish_reason: length`, `reasoning` full of thinking |
| `max_tokens: 800` | `content: "KILO_OK"` |

A three-word answer cost **481 completion tokens, 474 of them reasoning tokens**.

So:

- **Budget at least 2048 `maxTokens`** for this provider (the plugin default).
  1024 - the framework default - will frequently return nothing but thoughts.
  For long answers from a reasoning model, budget reasoning tokens + answer
  tokens: roughly `expected_answer_tokens + 500..1500`.
- `reasoning` is returned on the response object (`KiloAIResponse.reasoning`,
  `.reasoningTokens`) and is **never** concatenated into `content`.
- When `content` is empty but reasoning is not, the provider does **not** return
  an empty string. It returns a diagnosable line and sets `reasoningOnly: true`:

  ```
  [kilo] tencent/hy3:free returned no answer - the whole reply was
  chain-of-thought (474 reasoning tokens, finish_reason=length).
  Raise ai.maxTokens above 2048 and retry.
  ```

  and logs a `warn` saying the token budget was consumed by the reasoning chain.

### 2. Errors arrive as HTTP 200

Calling a **paid** model with a negative balance returns `HTTP 200` with no
`choices` at all:

```json
{"error":{"title":"Paid Model - Credits Required",
          "message":"Add credits to continue, or switch to a free model",
          "balance":-0.008184,"buyCreditsUrl":"..."},
 "error_type":"usage_limit_exceeded"}
```

A stock OpenAI client treats 200 as success and then crashes on
`choices[0].message`. This provider **checks the error envelope before touching
`choices`** and throws a non-retryable `AIError`.

Two envelope shapes exist and both are parsed:

| shape | example | mapped to |
|---|---|---|
| `error` is an **object** (HTTP 200) | `usage_limit_exceeded` | `kind: 'auth'`, `retryable: false` |
| `error` is a **string** (real HTTP 400) | `{"error":"Invalid path","error_type":"invalid_path"}` | `kind: 'bad_request'`, `retryable: false` |

`AIErrorKind` lives in `src/ai/types.ts` and a plugin must not extend it, so
credit exhaustion is reported as a non-retryable **`auth`** error - retrying
cannot fix a negative balance. The `error_type` and the balance are kept in the
message so the cause stays obvious.

A body with neither `choices` nor an error envelope also throws (`kind:
'unknown'`) instead of dereferencing `undefined`.

### 3. `health()` cannot validate the key

The gateway does **not** verify the bearer token: a request with a bogus key
still returns a 200 completion. `health()` therefore probes `GET /models` and
reports **reachability only**:

```
{ ok: true, detail: 'reachable, 349 models (key validity NOT verifiable)' }
```

Never read `ok: true` as "the credentials work". A missing key is reported as
`ok: false` before any request is made.

## Free models (measured: 10 of 349)

```
stepfun/step-3.7-flash:free                        ctx=262144
poolside/laguna-s-2.1:free                         ctx=262144
tencent/hy3:free                                   ctx=262144   <- default
inclusionai/ling-3.0-tiny:free                     ctx=262144
poolside/laguna-xs-2.1:free                        ctx=262144
cohere/north-mini-code:free                        ctx=256000
nvidia/nemotron-3.5-content-safety:free            ctx=128000
nvidia/nemotron-3-ultra-550b-a55b:free             ctx=1000000
nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free ctx=256000
nvidia/nemotron-3-super-120b-a12b:free             ctx=262144
```

Anything without the `:free` suffix bills credits; on an account with a negative
balance every such call returns the `usage_limit_exceeded` envelope described
above.

## Behaviour contract

- Only `AIError` escapes `chat()` - carrying `kind`, `status`, `attempts`,
  `retryable`. No raw fetch/JSON failure ever leaks.
- Retries cover **timeout / network / 5xx / 429** only. Auth, credit and
  bad-request failures are never retried. Backoff is exponential with +-20%
  jitter and honours `Retry-After` (capped at 30s).
- Timeouts use an `AbortController` cleared in a `finally`, combined with the
  caller's `options.signal`; an external abort yields `kind: 'aborted'`.
- Streaming (`stream: true` **and** an `onDelta` callback) forwards
  `delta.content` only; `delta.reasoning` is accumulated separately, and the
  usage frame at the end is picked up.
- Missing key: the plugin still loads and registers the factory; the first
  `chat()` throws `kind: 'auth'` with a message naming `KILO_API_KEY`.
- No `console.log` anywhere - all logging goes through the injected logger.

## Tests

The root `vitest.config.ts` only globs `src/**/*.test.ts`, and the root
`tsconfig.json` excludes `plugins/`. Both are shared files this plugin does not
touch, so it ships its own:

```bash
npx tsc -p plugins/kilo-provider/tsconfig.json          # type-check
npx vitest run --config plugins/kilo-provider/vitest.config.ts   # unit tests
```

Every test injects a fake `fetch` (`new KiloProvider(settings, { logger,
fetchImpl })`); no test touches the network and no key appears in the repo.
