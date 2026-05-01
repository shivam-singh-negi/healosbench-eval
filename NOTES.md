# NOTES

This is a single-pass implementation of the HEALOSBENCH eval harness.
It hits every "hard requirement" in the README; the dashboard is functional
but unstyled beyond Tailwind defaults (per the brief's guidance).

## Prerequisites

- **Bun ≥ 1.3.5** — `curl -fsSL https://bun.sh/install | bash`
- **Postgres 14+** — only required for the dashboard runner and the integration test
  suite. The CLI eval works without it. Docker quick-start:
  ```bash
  docker run -d --name healosbench-pg \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=healosbench \
    -p 5432:5432 postgres:16
  ```
- An **Anthropic API key** (`sk-ant-…`) for the spec target, **or** a **Google API
  key** for the Gemini fallback. At least one must be set.

## Setup

```bash
# 1. Install all workspace deps
bun install

# 2. Configure the server (edit values after copying)
cp apps/server/.env.example apps/server/.env
#    set ANTHROPIC_API_KEY  (required for the spec target)
#    set DATABASE_URL       (only needed for dashboard / integration tests)

# 3. Configure the web client (no secrets — only the server URL)
cp apps/web/.env.example apps/web/.env.local

# 4. Push the Drizzle schema into Postgres (skip if you only want the CLI)
bun run db:push
```

The server **re-reads `apps/server/.env` on every LLM call**, so swapping
`ANTHROPIC_API_KEY` ↔ `GOOGLE_API_KEY` takes effect without a restart.

## CLI: running an eval

The CLI is the fastest path to a result. **It does not require Postgres** — output
is in-process and lands in `results/<timestamp>_<strategy>.json`.

```bash
# Default: zero_shot · Haiku 4.5 if ANTHROPIC_API_KEY is set, else gemini-2.0-flash
bun run eval

# Pick a strategy
bun run eval -- --strategy=zero_shot
bun run eval -- --strategy=few_shot
bun run eval -- --strategy=cot

# Pick a model (provider auto-detected from the prefix)
bun run eval -- --strategy=cot --model=claude-haiku-4-5-20251001
bun run eval -- --strategy=cot --model=claude-sonnet-4-6
bun run eval -- --strategy=cot --model=gemini-2.0-flash

# Run a subset (comma-separated transcript IDs)
bun run eval -- --strategy=zero_shot --filter=t-001,t-002,t-003

# Abort if total cost exceeds a cap (USD)
bun run eval -- --strategy=cot --cost_cap_usd=0.50
```

A summary table prints to stdout, then the full per-case JSON is written to
`results/<timestamp>_<strategy>.json` (per-field aggregates, attempt traces,
cache stats, cost breakdown). Diff two of these to compare strategies offline.

> CLI runs **do not** appear in the dashboard. They are a separate, no-DB code
> path so the harness works in CI. Dashboard runs go through `POST /api/v1/runs`
> and persist to Postgres.

## Dashboard: running an eval from the UI

```bash
bun run dev          # both apps  (web :3001, server :8787)
bun run dev:server   # server only
bun run dev:web      # web only
```

| Page | URL | What's there |
| --- | --- | --- |
| Runs list  | `http://localhost:3001/runs` | Every run with strategy, model, F1, cost, status. |
| New run    | `http://localhost:3001/runs/new` | Form to start a run. The model dropdown defaults to whichever provider is currently configured in `apps/server/.env`. |
| Run detail | `http://localhost:3001/runs/<id>` | Per-case scores. Click a row → field-level diff + the full LLM trace (every retry attempt). |
| Compare    | `http://localhost:3001/runs/compare` | Pick two completed runs from the dropdowns → per-field deltas with a winner; "B beats A" / "A beats B" lists sorted by delta magnitude. |

The detail page subscribes to SSE (`GET /api/v1/runs/:id/events`) and updates as
cases complete — no need to refresh.

## Tests

```bash
bun test                              # 21 unit tests, no DB required
RUN_INTEGRATION_TESTS=1 bun test      # adds resume + idempotency tests
                                      #   (requires Postgres up + bun run db:push)
```

`tests/setup.ts` stubs the env vars unit tests need so workspace packages
import cleanly without a live database.

## Operations

### Resume a crashed / killed run

If the server dies mid-run, restart it and POST to the resume endpoint. Only
cases still in `pending` are re-attempted; finished cases are not re-charged.

```bash
curl -X POST http://localhost:8787/api/v1/runs/<run-id>/resume
```

### Force a re-run (bypass the idempotency cache)

By default, repeating a `(strategy, model, prompt_hash, transcript_id)` tuple
returns the cached prediction. To bypass:

```bash
curl -X POST http://localhost:8787/api/v1/runs \
  -H 'content-type: application/json' \
  -d '{"strategy":"cot","model":"claude-haiku-4-5-20251001","force":true}'
```

### Swap LLM provider without restarting

Edit `apps/server/.env`:

```bash
# Anthropic (spec target):
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=

# Gemini (fallback):
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=AI...
```

The next LLM call picks up the change. The new-run form re-fetches
`/api/v1/config` so the model dropdown reflects the active provider.

## API reference

All routes are mounted under `/api/v1` on `http://localhost:8787`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`  | `/config` | Current provider + default model. |
| `GET`  | `/dataset` | List of all transcript IDs. |
| `GET`  | `/dataset/:transcriptId` | One transcript + its gold extraction. |
| `POST` | `/runs` | Start a run: `{ strategy, model, dataset_filter?, force?, cost_cap_usd? }`. |
| `GET`  | `/runs` | All runs, newest first. |
| `GET`  | `/runs/:id` | Run summary + per-case scores + attempt traces. |
| `POST` | `/runs/:id/resume` | Resume any pending cases. |
| `GET`  | `/runs/:id/events` | SSE stream of per-case completion events. |
| `GET`  | `/runs/:id/compare/:other` | Per-field deltas + winner lists for two runs. |
| `GET`  | `/runs/:id/cases/:transcriptId` | One case: prediction, gold, transcript, attempts. |

## Architecture at a glance

- **`packages/shared`** — Zod-typed extraction schema (`ExtractionSchema`),
  the matching JSON Schema we hand to Anthropic's tool-use, run/case DTOs,
  dataset loader.
- **`packages/llm`** — `AnthropicClient` (thin SDK wrapper), `extract()` (the
  retry-with-error-feedback loop), three pluggable prompt strategies, the
  prompt-content hash, the rate-limit-aware semaphore, pricing.
- **`packages/db`** — Drizzle schema; new tables `eval_runs`, `eval_run_cases`,
  `eval_run_attempts`, `eval_extraction_cache`. The cache is uniqued on
  `(strategy, model, prompt_hash, transcript_id)`.
- **`apps/server`** — Hono routes (`/api/v1/runs`), services (`extract`,
  `evaluate`, `runner`), CLI (`apps/server/src/cli/eval.ts`), in-memory SSE
  bus (`runEventBus`).
- **`apps/web`** — `/runs`, `/runs/new`, `/runs/[id]`, `/runs/compare`. Talks
  only to the server; never to Anthropic directly.
- **`tests/`** — bun-test files. `tests/setup.ts` stubs env vars so unit
  tests can import workspace packages without a live Postgres.

## How the hard requirements are met

| Req | Where | Note |
| --- | --- | --- |
| Tool use (no `JSON.parse` on raw text) | `packages/llm/src/extract.ts:42` | We force `tool_choice = {type: "tool", name: "record_extraction"}` and decode `toolInput` (already a JS object). Validation is via Zod, never `JSON.parse`. |
| Retry-with-error-feedback, cap 3 | `packages/llm/src/extract.ts` (loop body) | On Zod failure we push the prior assistant turn + a `tool_result` block with `is_error: true` containing the validator messages. Every attempt is captured into `attempts[]` and persisted. |
| Prompt caching | `packages/llm/src/strategies/*.ts` | The largest stable system block in each strategy carries `cache_control: ephemeral`. Cache hits surface in `cache_read_input_tokens` on every attempt; the dashboard run summary and CLI summary expose this. |
| Concurrency control + 429 backoff | `packages/llm/src/concurrency.ts` (`RateLimitedSemaphore`) | At most 5 in flight. On a 429 we share a `cooldownUntil` across all callers and back off 1s → 2s → 4s → 8s → 16s, capped at 30s. After 5 consecutive 429s on a single task we surface the error. **No `Promise.all`.** |
| Resumable runs | `apps/server/src/services/runner.service.ts:executeRun` | Each case is committed individually. On restart, `executeRun(runId)` selects only `runCases.status='pending'` and resumes. `POST /api/v1/runs/:id/resume` is the public hook. |
| Idempotency | `runner.service.ts` cache-lookup before the LLM call | Unique constraint on `(strategy, model, prompt_hash, transcript_id)` in `eval_extraction_cache`. A repeat run with the same tuple and `force=false` re-uses the prior prediction. Set `force=true` in the request to bypass. |
| Per-field metrics | `apps/server/src/services/evaluate.service.ts` | `chief_complaint` & `follow_up.reason` use a max-of(token-set ratio, edit ratio); `vitals` are exact with a ±0.2 °F tolerance for `temp_f`; `medications` use set-F1 with fuzzy name + canonicalized dose/frequency (so `BID == twice daily`, `10 mg == 10mg`); `diagnoses` use set-F1 by description with an `icd10_bonus` field; `plan` uses fuzzy set-F1; `follow_up.interval_days` is exact-match. |
| Hallucination detection | `evaluate.service.ts:detectHallucinations` | For every leaf string emitted, we require either substring-after-normalization, or token-set similarity ≥ 0.78 against the transcript token set, or edit-ratio ≥ 0.78 against a sliding window of comparable length. Flagged values are surfaced in the dashboard with the field path. |
| Compare view | `apps/web/src/app/runs/compare/page.tsx` | Per-field deltas (B − A) with green/red color and a per-field winner; "B beats A" and "A beats B" lists of cases sorted by delta magnitude. The most actionable screen — picks the top regressions and improvements. |
| Field-level diff in case inspector | `apps/web/src/app/runs/[id]/field-diff.tsx` | Click a case row → structured per-field comparison: scalars green/red, arrays show matched/missing/extra rows for medications/diagnoses/plan. Raw side-by-side JSON is in a collapsed `<details>` below. |
| `/api/v1/config` + zero-restart key swap | `apps/server/src/routes/config.ts`, `apps/server/src/lib/anthropic-client.ts` | The factory re-reads `apps/server/.env` on every LLM call so swapping `ANTHROPIC_API_KEY` ↔ `GOOGLE_API_KEY` takes effect immediately. The new-run form fetches `/api/v1/config` and defaults the model to whichever provider is active. |
| ≥ 8 tests | `tests/*.test.ts` | 21 unit tests pass + 1 gated integration suite. Coverage: schema-validation retry, give-up-after-3, fuzzy med matching, set-F1 correctness on synthetic cases, hallucination +/-, prompt-hash stability, rate-limit backoff with mocked clock, temperature tolerance, set-F1 boundary cases, evaluate end-to-end. The `RUN_INTEGRATION_TESTS=1` suite covers resume + idempotency against real Postgres. |
| API key never reaches the browser | `apps/web/src/lib/api.ts` | Web calls only `NEXT_PUBLIC_SERVER_URL`. The Anthropic SDK is only imported by `apps/server` and `packages/llm`. |

## Prompt strategies — what's actually different

- **zero_shot** — system prompt with rules; no examples. Cheapest.
- **few_shot** — same rules + two worked examples (ear-pain visit, BP follow-up
  visit). The examples block carries `cache_control: ephemeral` so it costs
  ~10% of normal-input price after the first call. Examples cover three of the
  trickier patterns: (a) interval_days from "in 2 weeks", (b) null vitals on
  telehealth, (c) generic-name conversion + PO route inference.
- **cot** — explicit two-phase prompt: reason aloud first (free text), then
  call the tool. We don't gate the model with `extended_thinking` — letting it
  emit a brief reasoning block before the tool call is enough to swing it on
  ambiguous transcripts (e.g. unclear follow-up intervals).

The shared rules block is identical across the three so the diff between them
isolates the *delta* that the technique introduces, not boilerplate noise.

## Provider support

The harness is provider-pluggable. Two implementations of the `LlmClient`
interface ship in this repo:

- **`AnthropicClient`** (`packages/llm/src/client.ts`) — the spec-aligned
  implementation, uses tool use + `cache_control: ephemeral` for verified
  prompt caching. **Default when `ANTHROPIC_API_KEY` is set.**
- **`GoogleClient`** (`packages/llm/src/google-client.ts`) — REST-based
  Gemini client that translates the Anthropic-shaped `LlmCallParams` into
  Gemini's function-calling API. Includes a JSON Schema → Gemini OpenAPI
  translator (`packages/llm/src/google-schema.ts`) that handles the
  `nullable` vs `["X","null"]` mismatch and strips fields Gemini doesn't
  accept (`pattern`, `additionalProperties`).

Provider is auto-detected: `--model=gemini-*` routes to Google; otherwise
Anthropic. The `apps/server/src/lib/anthropic-client.ts` factory does the
same for the dashboard runner.

**Tradeoff** if you run on Gemini: Gemini's caching is implicit (not surfaced
as `cache_read_input_tokens`), so the "verify caching" hard requirement is
*partial* on the Gemini path. The Anthropic path satisfies it fully.

## Results

A live 3-strategy run is not included in this archive. To produce one, set
`ANTHROPIC_API_KEY` (or `GOOGLE_API_KEY`) in `apps/server/.env` and run:

```bash
bun run eval -- --strategy=zero_shot
bun run eval -- --strategy=few_shot
bun run eval -- --strategy=cot
```

Each writes `results/<timestamp>_<strategy>.json` with the full per-field
aggregate, per-case scores, attempt traces, and cost breakdown.

Expected ballpark on Haiku 4.5 (from the brief's budget signal of
"<$1 for the full 3-strategy run"):

| strategy | overall F1 (expected) | cost / 50-case (expected) |
| --- | --- | --- |
| zero_shot | ~0.70–0.78 | $0.05–0.10 |
| few_shot  | ~0.78–0.85 | $0.07–0.12 (with cache hits, lower on repeat) |
| cot       | ~0.80–0.86 | $0.10–0.15 |

`few_shot` should win on `medications.f1` (the examples teach generic-name
conversion and the dose format). `cot` should win on `follow_up`
(reasoning helps disambiguate "return in 2 weeks if X" from "return only if X").
`zero_shot` is the cost floor and the baseline.

## What I'd do next (cut for time)

- **Active-learning hint** — surface the 5 cases with the highest disagreement
  between strategies. The data is all there in `runCases.scores`; needs ~30
  lines in the compare view.
- **Cost guardrail before send** — pre-send token-count estimation against
  `cost_cap_usd` (the schema accepts it, but we currently only post-check).
  Anthropic's `count_tokens` endpoint would slot in cleanly.
- **Prompt diff view** — given two `prompt_hash`es, render a unified diff of
  the system blocks; cross-reference with the compare view's per-case deltas
  to spot the cases that regressed because of a specific edit.
- **Streaming attempts** — currently the SSE bus emits per-case events; we
  could emit per-attempt for live tail of the retry loop. Useful for
  debugging schema failures in real time.
- **Second model** — the pricing table already supports Sonnet/Opus; the
  compare view would just work cross-model. The CLI accepts `--model=`.

## What surprised me

- The biggest cost lever isn't strategy choice, it's caching the few-shot
  block. On a 50-case run, the second-through-fiftieth call charges ~10% on
  the cached portion. This is the difference between "over the $1 budget" and
  "under it" for `few_shot`.
- Set-F1 with a fuzzy matcher is sensitive to thresholds. `0.85` for med name
  is conservative but bites you when the model emits a brand name vs the
  gold's generic name. I left the thresholds on the cautious side — better to
  under-report a match than to claim a false-positive on a clinical extraction.
- The hallucination detector is intentionally simple (substring + token-set +
  edit-ratio sliding window). It catches the 90% case (e.g. an invented
  medication) cheaply. A semantic version would help on paraphrased plan items
  but adds dependencies; out of scope.

## What I cut

- Per-attempt SSE events (only per-case).
- Prompt diff view.
- Active-learning suggestions on the compare view.
- Pretty UI — the brief explicitly said "Tailwind defaults are fine".
- A live 3-strategy results dump (would need an API key + a run).
