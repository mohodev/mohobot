# model-catalog

Model directory and metadata linter for the Kilo AI gateway
(`https://api.kilo.ai/api/gateway/v1`). Pure plugin: it adds four commands and
touches **nothing** under `src/`.

| Command | What it does |
|---|---|
| `!freemodels [--refresh]` | Lists every `:free` model with its context window. Cached in `ctx.storage`, TTL configurable (default 1h). |
| `!modelinfo <id>` | Context window, max completion tokens, per-million pricing, supported parameters, free flag, repaired description. Accepts partial ids. |
| `!lint [--refresh]` | Scans the whole catalog and reports metadata defects, grouped by kind. |
| `!probefree` | Manual only. Sends a one-token prompt to each free model, serially, under a per-request timeout and a global time budget, and reports which ones actually answer. |

## Layout

```
plugins/model-catalog/
  plugin.json        manifest + config block
  index.ts           plugin wiring: commands, config, logging, error containment
  catalog.ts         pure functions: parse / sanitize / lint / select / format
  client.ts          /models fetch + cache + probe (fetch is injectable)
  catalog.test.ts    33 tests, fixture-driven, zero network
  tsconfig.json      typecheck config (root tsconfig excludes plugins/)
  vitest.config.ts   test config (root vitest only globs src/)
  README.md
```

## Config (`plugin.json` -> `config`)

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://api.kilo.ai/api/gateway/v1` | Gateway root |
| `apiKeyEnv` | `KILO_API_KEY` | Env var the key is read from |
| `cacheTtlSeconds` | `3600` | Catalog cache lifetime |
| `requestTimeoutMs` | `15000` | `/models` timeout |
| `lintPreviewCount` | `10` | Issues shown inline by `!lint` |
| `probeEnabled` | `true` | Master switch for `!probefree` |
| `probeTimeoutMs` | `20000` | Per-model probe timeout |
| `probeBudgetMs` | `90000` | Whole-sweep ceiling |
| `probeLimit` | `10` | Max models per sweep |

The API key is read from the environment only. It is registered with
`registerSecret()` on load, never persisted to storage, never logged, and error
bodies are passed through `scrub()` before they are shown.

## The 10 free models (live catalog, 349 models total)

Measured against the real gateway:

| # | id | context |
|---|---|---|
| 1 | `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 |
| 2 | `inclusionai/ling-3.0-tiny:free` | 262,144 |
| 3 | `nvidia/nemotron-3-super-120b-a12b:free` | 262,144 |
| 4 | `poolside/laguna-s-2.1:free` | 262,144 |
| 5 | `poolside/laguna-xs-2.1:free` | 262,144 |
| 6 | `stepfun/step-3.7-flash:free` | 262,144 |
| 7 | `tencent/hy3:free` | 262,144 |
| 8 | `cohere/north-mini-code:free` | 256,000 |
| 9 | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256,000 |
| 10 | `nvidia/nemotron-3.5-content-safety:free` | 128,000 |

`kilo-auto/free` and `openrouter/free` also carry `isFree: true` and zero
pricing but have no `:free` suffix - they are routers, not models, so
`filterFree()` keeps the suffix as the canonical test and exposes `isFreeFlag` /
`zeroPriced` separately for callers that care.

## The `inclusionai/ling-3.0-flash` description problem

Raw value served by the gateway:

```
*Ling-3.0-flash* is a *124B-parameter Mixture-of-Experts (MoE) model*, with approximately
*5.1B parameters activated per token*. The model is designed with *token efficiency and
production-scale agentic inference* as key priorities, enabling developers...
```

**How it is detected.** `hasSingleAsteriskEmphasis()` first deletes every
well-formed `**bold**` run, then looks for a surviving `*...*` pair. Anything
left can only be single-asterisk emphasis. Across the live 349-model catalog
this fires on exactly one model - this one - so the rule is specific, not a
blanket "contains an asterisk" heuristic.

**Why it matters.** In Markdown (and therefore in Discord) a single `*` is
*italic*, but the upstream intent is clearly **bold**. Worse, the asterisks pair
up across sentence boundaries: `...model*, with approximately *5.1B...` means
the comma and the words between the two runs get swallowed into an italic span,
so the rendered blurb drifts out of sync with the text.

**How it is repaired.** `sanitizeDescription()`:

1. parks every existing `**bold**` run behind a placeholder so it cannot be
   damaged;
2. rewrites each remaining `*...*` pair as `**...**` (left to right, which
   reproduces the intended pairing - the description has an even number of
   asterisks);
3. drops any leftover unpaired `*` so Discord cannot swallow punctuation;
4. normalises the trailing `...` to a single ellipsis so a truncated blurb reads
   as truncated.

Result:

```
**Ling-3.0-flash** is a **124B-parameter Mixture-of-Experts (MoE) model**, with approximately
**5.1B parameters activated per token**. The model is designed with **token efficiency and
production-scale agentic inference** as key priorities, enabling developers…
```

## Lint rules

| Kind | Live count (349 models) | Rule |
|---|---|---|
| `single-asterisk-markdown` | 1 | emphasis with single `*` outside any `**bold**` run |
| `missing-vendor-prefix` | 31 | `name` does not start with `"<vendor>: "` although the id has a vendor segment |
| `tilde-prefixed-id` | 11 | id starts with `~` (moving alias such as `~openai/gpt-latest`) |
| `truncated-description` | 285 | description ends in `...` / an ellipsis |
| `empty-description` | 0 | description missing or blank |
| `missing-context-length` | 0 | no usable `context_length` on the model or its `top_provider` |

Total on the live catalog: **328 issues across 349 models**.

## Failure behaviour

Nothing here can take the bot down:

- missing key -> `Could not read the model catalog: KILO_API_KEY is not set...`
- connection refused / DNS failure -> the underlying message, one line
- timeout -> `model list timed out after 15000ms` (AbortController, always cleared)
- non-2xx -> `HTTP <status>` plus a scrubbed 180-char body snippet
- non-JSON body -> `model list response was not valid JSON: <snippet>`
- empty or malformed entries -> skipped by `parseModels`, never thrown
- refresh failure with a warm cache -> stale cache is served with a warning line

Paid models are the interesting case: on this account the gateway answers a
paid model with `{"error":{"title":"Paid Model - Credits Required",...},
"error_type":"usage_limit_exceeded"}`. It has been observed both as HTTP 200 and
(in the live run behind this README) as HTTP 402, so `probeModel()` treats *both*
as failures: a non-2xx status, an `error` field, or a missing/empty `choices`
array all mean "unusable", regardless of the status code.

## Verification

The root `tsconfig.json` excludes `plugins/` and the root `vitest.config.ts`
only globs `src/**/*.test.ts`; this plugin therefore ships its own configs
instead of editing shared ones.

```bash
npx tsc -p plugins/model-catalog/tsconfig.json --noEmit
npx vitest run --config plugins/model-catalog/vitest.config.ts
```

All tests are offline: they use a frozen fixture that reproduces the four defect
classes (including the verbatim `ling-3.0-flash` description) plus an injected
fake `fetch` for the client and probe paths.
