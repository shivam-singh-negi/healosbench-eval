#!/usr/bin/env bun
/**
 * CLI runner: bun run eval -- --strategy=zero_shot --model=...
 *
 * - No DB writes; everything is in-process so the CLI works in CI without
 *   Postgres. Results are written to results/<run-id>.json and a summary
 *   table is printed to stdout.
 * - The dashboard runner (runner.service) shares the evaluator + LLM code
 *   paths, so output is consistent.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AnthropicClient,
  GoogleClient,
  RateLimitedSemaphore,
  getStrategy,
  hashStrategy,
  type LlmClient,
} from "@test-evals/llm";
import { STRATEGIES, type Strategy } from "@test-evals/shared";
import { loadDataset } from "@test-evals/shared/dataset";

import { findRepoRoot } from "../lib/repo-root";
import { evaluate, type FieldScores } from "../services/evaluate.service";
import { runExtraction } from "../services/extract.service";
import { aggregateScores } from "../services/runner.service";

interface CliArgs {
  strategy: Strategy;
  model: string;
  filter?: string[];
  costCapUsd?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const flags: Record<string, string> = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq < 0) flags[a.slice(2)] = "true";
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const strategy = (flags.strategy ?? "zero_shot") as Strategy;
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`unknown strategy: ${strategy}. expected one of ${STRATEGIES.join(", ")}`);
  }
  // Default model depends on which credential is present, so the CLI
  // works out-of-the-box for either provider.
  const defaultModel = process.env.ANTHROPIC_API_KEY
    ? "claude-haiku-4-5-20251001"
    : "gemini-2.0-flash";
  return {
    strategy,
    model: flags.model ?? defaultModel,
    filter: flags.filter ? flags.filter.split(",") : undefined,
    costCapUsd: flags.cost_cap_usd ? Number(flags.cost_cap_usd) : undefined,
  };
}

function pickClient(model: string): LlmClient {
  if (model.startsWith("gemini")) {
    const k = process.env.GOOGLE_API_KEY;
    if (!k) {
      console.error("GOOGLE_API_KEY is not set. Add it to apps/server/.env or your shell.");
      process.exit(2);
    }
    return new GoogleClient(k);
  }
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) {
    console.error("ANTHROPIC_API_KEY is not set. Add it to apps/server/.env or your shell.");
    process.exit(2);
  }
  return new AnthropicClient(k);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = pickClient(args.model);
  const strategy = getStrategy(args.strategy);
  const promptHash = hashStrategy(strategy);
  const dataset = loadDataset(findRepoRoot(), args.filter);

  console.log(
    `running ${dataset.length} cases · strategy=${args.strategy} · model=${args.model} · prompt=${promptHash}`,
  );

  // Gemini's free tier is 5 RPM per model; we drop to 1-in-flight and let
  // the backoff/retry-after handler space requests out. Anthropic happily
  // takes the full 5.
  const concurrency = args.model.startsWith("gemini") ? 1 : 5;
  const sem = new RateLimitedSemaphore({ concurrency });
  const startedAt = Date.now();
  let totalCost = 0;
  let schemaInvalid = 0;
  let hallucinationCount = 0;
  const perCase: {
    transcriptId: string;
    scores: FieldScores | null;
    schemaInvalid: boolean;
    hallucinations: string[];
    costUsd: number;
    durationMs: number;
    cacheRead: number;
  }[] = [];

  let done = 0;
  await Promise.all(
    dataset.map((c) =>
      sem.run(async () => {
        const result = await runExtraction({
          client,
          strategy: args.strategy,
          model: args.model,
          transcript: c.transcript,
        });
        let scores: FieldScores | null = null;
        let halls: string[] = [];
        if (result.extraction) {
          const e = evaluate(result.extraction, c.gold, c.transcript);
          scores = e.scores;
          halls = e.hallucinations;
        }
        totalCost += result.totalCostUsd;
        if (result.schemaInvalid) schemaInvalid++;
        hallucinationCount += halls.length;
        perCase.push({
          transcriptId: c.transcriptId,
          scores,
          schemaInvalid: result.schemaInvalid,
          hallucinations: halls,
          costUsd: result.totalCostUsd,
          durationMs: result.totalDurationMs,
          cacheRead: result.totalUsage.cacheReadInputTokens,
        });
        done++;
        process.stdout.write(
          `\r  [${done}/${dataset.length}] ${c.transcriptId} cost=$${totalCost.toFixed(3)}    `,
        );
        if (args.costCapUsd && totalCost > args.costCapUsd) {
          throw new Error(`cost cap exceeded: $${totalCost.toFixed(3)} > $${args.costCapUsd}`);
        }
      }),
    ),
  );
  process.stdout.write("\n");

  const aggregate = aggregateScores(
    perCase.map((p) => p.scores).filter(Boolean) as FieldScores[],
  );
  const wallMs = Date.now() - startedAt;

  console.log("");
  console.log(
    `summary · strategy=${args.strategy} · prompt=${promptHash} · cost=$${totalCost.toFixed(4)} · wall=${(wallMs / 1000).toFixed(1)}s`,
  );
  console.log(
    `         · schema_invalid=${schemaInvalid}/${dataset.length} · hallucinations=${hallucinationCount}`,
  );
  console.log("");
  console.log(table(aggregate));
  console.log("");

  const outDir = join(findRepoRoot(), "results");
  mkdirSync(outDir, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${args.strategy}`;
  const outFile = join(outDir, `${runId}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        strategy: args.strategy,
        model: args.model,
        promptHash,
        totalCostUsd: totalCost,
        wallMs,
        schemaInvalid,
        hallucinationCount,
        aggregate,
        perCase,
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${outFile}`);
}

function table(a: ReturnType<typeof aggregateScores>): string {
  const rows: [string, number][] = [
    ["chief_complaint", a.chief_complaint],
    ["vitals", a.vitals],
    ["medications_f1", a.medications_f1],
    ["diagnoses_f1", a.diagnoses_f1],
    ["plan_f1", a.plan_f1],
    ["follow_up", a.follow_up],
    ["overall", a.overall],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(w)}  ${(v * 100).toFixed(1).padStart(5)}%`).join("\n");
}

main().catch((err) => {
  console.error("\n[eval] failed:", err);
  process.exit(1);
});
