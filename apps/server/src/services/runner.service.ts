import { randomUUID } from "node:crypto";

import { db } from "@test-evals/db";
import {
  extractionCache,
  runAttempts,
  runCases,
  runs,
} from "@test-evals/db/schema/eval";
import {
  getStrategy,
  hashStrategy,
  isRateLimitError,
  RateLimitedSemaphore,
  type LlmClient,
} from "@test-evals/llm";
import type { AggregateScores, DatasetCase, Strategy } from "@test-evals/shared";
import { loadDataset } from "@test-evals/shared/dataset";
import { and, eq } from "drizzle-orm";

import { findRepoRoot } from "../lib/repo-root";
import { runEventBus } from "./events";
import { runExtraction } from "./extract.service";
import { evaluate, type FieldScores } from "./evaluate.service";

// Anthropic comfortably accepts 5; Gemini's free tier is 5 RPM total per
// model, so we drop to 1-in-flight and lean on the semaphore's retry-after
// handler to space requests out across the per-minute window.
const concurrencyFor = (model: string) => (model.startsWith("gemini") ? 1 : 5);

export interface StartRunInput {
  strategy: Strategy;
  model: string;
  datasetFilter?: string[];
  force?: boolean;
  costCapUsd?: number;
  client: LlmClient;
}

/** Create a run row + per-case rows, return the run id. */
export async function createRun(input: StartRunInput): Promise<string> {
  const strategy = getStrategy(input.strategy);
  const promptHash = hashStrategy(strategy);
  const dataset = loadDataset(repoData(), input.datasetFilter);
  if (dataset.length === 0) throw new Error("no cases match dataset_filter");

  const runId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(runs).values({
      id: runId,
      strategy: input.strategy,
      model: input.model,
      promptHash,
      status: "pending",
      datasetFilter: input.datasetFilter ?? null,
      totalCases: dataset.length,
    });
    await tx.insert(runCases).values(
      dataset.map((c) => ({
        id: randomUUID(),
        runId,
        transcriptId: c.transcriptId,
        status: "pending" as const,
      })),
    );
  });
  return runId;
}

/**
 * Execute (or resume) a run. Iterates only over `pending` cases, so a
 * crash-and-restart picks up where we left off. Each completed case is
 * committed individually.
 */
export async function executeRun(runId: string, client: LlmClient): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run not found: ${runId}`);
  if (run.status === "completed") return;

  await db
    .update(runs)
    .set({ status: "running", startedAt: run.startedAt ?? new Date() })
    .where(eq(runs.id, runId));

  const dataset = loadDataset(repoData(), run.datasetFilter ?? undefined);
  const byTranscript = new Map(dataset.map((c) => [c.transcriptId, c] as const));

  const pending = await db
    .select()
    .from(runCases)
    .where(and(eq(runCases.runId, runId), eq(runCases.status, "pending")));

  const sem = new RateLimitedSemaphore({ concurrency: concurrencyFor(run.model) });

  let projectedCost = 0;

  await Promise.all(
    pending.map((rc) =>
      sem.run(async () => {
        const ds = byTranscript.get(rc.transcriptId);
        if (!ds) {
          await markCaseFailed(rc.id, "transcript missing from dataset");
          await bumpRunCounters(runId, { failedCases: 1 });
          return;
        }

        runEventBus.publish(runId, { type: "case_started", transcriptId: rc.transcriptId });
        await db.update(runCases).set({ status: "running" }).where(eq(runCases.id, rc.id));

        try {
          // Idempotency: if we already have a successful extraction for
          // (strategy, model, promptHash, transcriptId) and force=false,
          // copy that prediction instead of re-calling Anthropic.
          const cached = await db
            .select()
            .from(extractionCache)
            .where(
              and(
                eq(extractionCache.strategy, run.strategy),
                eq(extractionCache.model, run.model),
                eq(extractionCache.promptHash, run.promptHash),
                eq(extractionCache.transcriptId, rc.transcriptId),
              ),
            )
            .limit(1);

          if (cached.length > 0) {
            const sourceCase = await db
              .select()
              .from(runCases)
              .where(eq(runCases.id, cached[0]!.runCaseId))
              .limit(1);
            if (sourceCase[0]?.prediction) {
              await applyPredictionToCase({
                caseRow: rc,
                runId,
                run,
                ds,
                prediction: sourceCase[0].prediction as never,
                schemaInvalid: !!sourceCase[0].schemaInvalid,
              });
              return;
            }
          }

          const result = await runExtraction({
            client,
            strategy: run.strategy as Strategy,
            model: run.model,
            transcript: ds.transcript,
          });

          projectedCost += result.totalCostUsd;
          if (typeof projectedCost === "number" && Number.isFinite(projectedCost)) {
            // No-op: kept here so guardrail logic is easy to slot in later.
          }

          let scores: FieldScores | null = null;
          let hallucinations: string[] = [];
          if (result.extraction) {
            const evalResult = evaluate(result.extraction, ds.gold, ds.transcript);
            scores = evalResult.scores;
            hallucinations = evalResult.hallucinations;
          }

          await db.transaction(async (tx) => {
            await tx
              .update(runCases)
              .set({
                status: result.extraction ? "completed" : "failed",
                prediction: result.extraction ?? null,
                scores: scores ?? null,
                hallucinations,
                schemaInvalid: result.schemaInvalid ? 1 : 0,
                totalCostUsd: result.totalCostUsd,
                totalDurationMs: result.totalDurationMs,
                inputTokens: result.totalUsage.inputTokens,
                outputTokens: result.totalUsage.outputTokens,
                cacheReadInputTokens: result.totalUsage.cacheReadInputTokens,
                cacheCreationInputTokens: result.totalUsage.cacheCreationInputTokens,
                completedAt: new Date(),
                error: result.extraction ? null : "schema-invalid after retries",
              })
              .where(eq(runCases.id, rc.id));

            for (const a of result.attempts) {
              await tx.insert(runAttempts).values({
                id: randomUUID(),
                runCaseId: rc.id,
                attempt: a.attempt,
                request: a.request,
                response: a.response,
                toolInput: a.toolInput as never,
                validationErrors: a.validationErrors,
                inputTokens: a.usage.inputTokens,
                outputTokens: a.usage.outputTokens,
                cacheReadInputTokens: a.usage.cacheReadInputTokens,
                cacheCreationInputTokens: a.usage.cacheCreationInputTokens,
                costUsd: a.costUsd,
                durationMs: a.durationMs,
              });
            }

            if (result.extraction && !result.schemaInvalid) {
              await tx
                .insert(extractionCache)
                .values({
                  strategy: run.strategy,
                  model: run.model,
                  promptHash: run.promptHash,
                  transcriptId: rc.transcriptId,
                  runCaseId: rc.id,
                })
                .onConflictDoNothing();
            }
          });

          await bumpRunTotals(runId, result, scores, hallucinations.length);

          const completedCase = await loadCase(rc.id);
          runEventBus.publish(runId, {
            type: "case_completed",
            transcriptId: rc.transcriptId,
            case: completedCase,
          });
        } catch (err) {
          // Re-throw rate-limit errors so the semaphore's backoff handles them
          // (otherwise we'd swallow the 429 and short-circuit the retry).
          if (isRateLimitError(err)) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          await markCaseFailed(rc.id, msg);
          await bumpRunCounters(runId, { failedCases: 1 });
          runEventBus.publish(runId, {
            type: "case_failed",
            transcriptId: rc.transcriptId,
            error: msg,
          });
        }
      }),
    ),
  );

  await finalizeRun(runId);
}

async function applyPredictionToCase(args: {
  caseRow: typeof runCases.$inferSelect;
  runId: string;
  run: typeof runs.$inferSelect;
  ds: DatasetCase;
  prediction: never;
  schemaInvalid: boolean;
}): Promise<void> {
  const { caseRow, runId, ds, prediction, schemaInvalid } = args;
  const evalResult = evaluate(prediction, ds.gold, ds.transcript);
  await db
    .update(runCases)
    .set({
      status: schemaInvalid ? "failed" : "completed",
      prediction,
      scores: evalResult.scores,
      hallucinations: evalResult.hallucinations,
      schemaInvalid: schemaInvalid ? 1 : 0,
      completedAt: new Date(),
    })
    .where(eq(runCases.id, caseRow.id));
  await bumpRunCounters(runId, {
    completedCases: schemaInvalid ? 0 : 1,
    failedCases: schemaInvalid ? 1 : 0,
    schemaFailureCount: schemaInvalid ? 1 : 0,
    hallucinationCount: evalResult.hallucinations.length,
  });
  const c = await loadCase(caseRow.id);
  runEventBus.publish(runId, {
    type: "case_completed",
    transcriptId: caseRow.transcriptId,
    case: c,
  });
}

async function markCaseFailed(caseId: string, error: string) {
  await db
    .update(runCases)
    .set({ status: "failed", error, completedAt: new Date() })
    .where(eq(runCases.id, caseId));
}

async function bumpRunCounters(
  runId: string,
  delta: Partial<{
    completedCases: number;
    failedCases: number;
    schemaFailureCount: number;
    hallucinationCount: number;
  }>,
) {
  const [r] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!r) return;
  await db
    .update(runs)
    .set({
      completedCases: r.completedCases + (delta.completedCases ?? 0),
      failedCases: r.failedCases + (delta.failedCases ?? 0),
      schemaFailureCount: r.schemaFailureCount + (delta.schemaFailureCount ?? 0),
      hallucinationCount: r.hallucinationCount + (delta.hallucinationCount ?? 0),
    })
    .where(eq(runs.id, runId));
}

async function bumpRunTotals(
  runId: string,
  result: {
    totalUsage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    };
    totalCostUsd: number;
    totalDurationMs: number;
    schemaInvalid: boolean;
    extraction: unknown;
  },
  _scores: FieldScores | null,
  hallucinationCount: number,
) {
  const [r] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!r) return;
  await db
    .update(runs)
    .set({
      completedCases: r.completedCases + (result.extraction ? 1 : 0),
      failedCases: r.failedCases + (result.extraction ? 0 : 1),
      schemaFailureCount: r.schemaFailureCount + (result.schemaInvalid ? 1 : 0),
      hallucinationCount: r.hallucinationCount + hallucinationCount,
      totalInputTokens: r.totalInputTokens + result.totalUsage.inputTokens,
      totalOutputTokens: r.totalOutputTokens + result.totalUsage.outputTokens,
      totalCacheReadInputTokens:
        r.totalCacheReadInputTokens + result.totalUsage.cacheReadInputTokens,
      totalCacheCreationInputTokens:
        r.totalCacheCreationInputTokens + result.totalUsage.cacheCreationInputTokens,
      totalCostUsd: r.totalCostUsd + result.totalCostUsd,
      totalDurationMs: r.totalDurationMs + result.totalDurationMs,
    })
    .where(eq(runs.id, runId));
}

async function loadCase(caseId: string) {
  const [c] = await db.select().from(runCases).where(eq(runCases.id, caseId));
  const attempts = await db
    .select()
    .from(runAttempts)
    .where(eq(runAttempts.runCaseId, caseId));
  return {
    id: c!.id,
    runId: c!.runId,
    transcriptId: c!.transcriptId,
    status: c!.status as never,
    prediction: c!.prediction,
    scores: c!.scores as never,
    hallucinations: c!.hallucinations,
    schemaInvalid: !!c!.schemaInvalid,
    attempts: attempts.map((a) => ({
      id: a.id,
      attempt: a.attempt,
      request: a.request,
      response: a.response,
      validationErrors: a.validationErrors ?? null,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      cacheReadInputTokens: a.cacheReadInputTokens,
      cacheCreationInputTokens: a.cacheCreationInputTokens,
      costUsd: a.costUsd,
      durationMs: a.durationMs,
      createdAt: a.createdAt.toISOString(),
    })),
    totalCostUsd: c!.totalCostUsd,
    totalDurationMs: c!.totalDurationMs,
    createdAt: c!.createdAt.toISOString(),
    completedAt: c!.completedAt?.toISOString() ?? null,
  };
}

async function finalizeRun(runId: string): Promise<void> {
  const allCases = await db.select().from(runCases).where(eq(runCases.runId, runId));
  const status =
    allCases.every((c) => c.status === "completed") && allCases.length > 0
      ? "completed"
      : "completed"; // we mark completed even with some failed cases; failed count surfaces this

  const aggregate = aggregateScores(allCases.map((c) => c.scores).filter(Boolean) as never[]);

  await db
    .update(runs)
    .set({
      status,
      completedAt: new Date(),
      aggregateF1: aggregate.overall,
      perFieldAggregate: aggregate,
    })
    .where(eq(runs.id, runId));

  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (run) {
    runEventBus.publish(runId, {
      type: "run_completed",
      run: serializeRun(run),
    });
  }
}

export function aggregateScores(scoresList: FieldScores[]): AggregateScores {
  if (scoresList.length === 0) {
    return {
      chief_complaint: 0,
      vitals: 0,
      medications_f1: 0,
      diagnoses_f1: 0,
      plan_f1: 0,
      follow_up: 0,
      overall: 0,
    };
  }
  const n = scoresList.length;
  const sum = scoresList.reduce(
    (acc, s) => ({
      chief_complaint: acc.chief_complaint + s.chief_complaint,
      vitals: acc.vitals + s.vitals,
      medications_f1: acc.medications_f1 + s.medications.f1,
      diagnoses_f1: acc.diagnoses_f1 + s.diagnoses.f1,
      plan_f1: acc.plan_f1 + s.plan.f1,
      follow_up: acc.follow_up + s.follow_up,
      overall: acc.overall + s.overall,
    }),
    {
      chief_complaint: 0,
      vitals: 0,
      medications_f1: 0,
      diagnoses_f1: 0,
      plan_f1: 0,
      follow_up: 0,
      overall: 0,
    },
  );
  return {
    chief_complaint: sum.chief_complaint / n,
    vitals: sum.vitals / n,
    medications_f1: sum.medications_f1 / n,
    diagnoses_f1: sum.diagnoses_f1 / n,
    plan_f1: sum.plan_f1 / n,
    follow_up: sum.follow_up / n,
    overall: sum.overall / n,
  };
}

export function serializeRun(r: typeof runs.$inferSelect) {
  return {
    id: r.id,
    strategy: r.strategy as Strategy,
    model: r.model,
    promptHash: r.promptHash,
    status: r.status as never,
    totalCases: r.totalCases,
    completedCases: r.completedCases,
    failedCases: r.failedCases,
    schemaFailureCount: r.schemaFailureCount,
    hallucinationCount: r.hallucinationCount,
    aggregateF1: r.aggregateF1,
    totalInputTokens: r.totalInputTokens,
    totalOutputTokens: r.totalOutputTokens,
    totalCacheReadInputTokens: r.totalCacheReadInputTokens,
    totalCacheCreationInputTokens: r.totalCacheCreationInputTokens,
    totalCostUsd: r.totalCostUsd,
    totalDurationMs: r.totalDurationMs,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
  };
}

function repoData(): string {
  return findRepoRoot();
}
