# HEALOSBENCH — Eval Harness for Structured Clinical Extraction

An end-to-end evaluation harness for an LLM that turns doctor–patient
transcripts into structured JSON (chief complaint, vitals, medications,
diagnoses, plan, follow-up). Built as a take-home assessment.

- **[`NOTES.md`](./NOTES.md)** — implementation write-up: architecture,
  requirements-to-code mapping, run instructions, prompt strategies,
  surprises, and what was cut.
- **[`ASSESSMENT.md`](./ASSESSMENT.md)** — original assessment brief,
  preserved for reference.

---

## What's in here

- **CLI runner** — `bun run eval -- --strategy=…` runs all 50 cases against
  Anthropic Claude or Google Gemini and writes per-case scores, attempt
  traces, cache stats, and cost to `results/<timestamp>_<strategy>.json`.
- **Three prompt strategies** — `zero_shot`, `few_shot`, `cot`, each a
  swappable module under `packages/llm/src/strategies/`.
- **Tool-use extraction** with Zod-validated retry-with-error-feedback
  (capped at 3 attempts), prompt-content hashing, and `cache_control:
  ephemeral` for Anthropic prompt caching.
- **Rate-limit-aware concurrency** — at most 5 in flight (1 for Gemini's
  free tier), shared exponential backoff on 429s, capped at 30s.
- **Dashboard** (Next.js) — runs list, per-case detail with field-level
  diff + full LLM trace, and a compare view that surfaces per-field deltas
  with a winner.
- **Idempotency + resume** — runs are cached on `(strategy, model,
  prompt_hash, transcript_id)`; killing the server mid-run and POSTing to
  `/api/v1/runs/:id/resume` continues from the last completed case.
- **22 tests** under `tests/` (21 unit + 1 gated integration suite for
  resume + idempotency).

## Quickstart

```bash
# 1. Install
bun install

# 2. Configure server  (set ANTHROPIC_API_KEY or GOOGLE_API_KEY)
cp apps/server/.env.example apps/server/.env

# 3. Configure web client
cp apps/web/.env.example apps/web/.env.local

# 4. Push DB schema  (only needed for the dashboard runner)
bun run db:push

# 5. Run an eval — no DB required; output lands in results/*.json
bun run eval -- --strategy=zero_shot

# Or boot the dashboard
bun run dev   # web :3001 · server :8787
```

Full setup, every CLI flag, dashboard URLs, API endpoints, and operational
recipes (resume a crashed run, force re-run, swap providers without a
restart) live in [`NOTES.md`](./NOTES.md).

## Project layout

```
apps/
  server/        Hono API + CLI runner
  web/           Next.js dashboard
packages/
  shared/        Extraction schema (Zod + JSON Schema), DTOs, dataset loader
  llm/           Anthropic + Google clients, prompt strategies, retry loop
  db/            Drizzle schema (eval_runs / cases / attempts / cache)
  auth env ui    Workspace plumbing (auth not used by the eval task)
  config
tests/           Bun-test files (unit + integration)
data/            50 transcripts + gold JSON  (provided)
```

## Stack

Bun · TypeScript · Hono · Next.js 16 · Drizzle ORM · Postgres · Anthropic SDK · Google AI · Tailwind
