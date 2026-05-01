import { db } from "@test-evals/db";
import { runAttempts, runCases, runs } from "@test-evals/db/schema/eval";
import {
  StartRunRequestSchema,
  type CompareView,
  type RunDetail,
  type RunSummary,
} from "@test-evals/shared";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { getAnthropicClient } from "../lib/anthropic-client";
import { runEventBus } from "../services/events";
import {
  aggregateScores,
  createRun,
  executeRun,
  serializeRun,
} from "../services/runner.service";

export const runsRouter = new Hono();

runsRouter.post("/", async (c) => {
  const body = await c.req.json();
  const parsed = StartRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
  }

  const client = getAnthropicClient();
  const runId = await createRun({
    strategy: parsed.data.strategy,
    model: parsed.data.model,
    datasetFilter: parsed.data.dataset_filter,
    force: parsed.data.force,
    costCapUsd: parsed.data.cost_cap_usd,
    client,
  });

  // Fire and forget. SSE consumers see progress; clients can also poll GET.
  void executeRun(runId, client).catch((err) => {
    console.error(`[runs] runId=${runId} failed:`, err);
    void db
      .update(runs)
      .set({ status: "failed", error: err instanceof Error ? err.message : String(err) })
      .where(eq(runs.id, runId));
    runEventBus.publish(runId, {
      type: "run_failed",
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return c.json({ id: runId }, 201);
});

runsRouter.post("/:id/resume", async (c) => {
  const id = c.req.param("id");
  const [r] = await db.select().from(runs).where(eq(runs.id, id));
  if (!r) return c.json({ error: "not_found" }, 404);
  if (r.status === "completed") return c.json({ id, status: "completed" });

  const client = getAnthropicClient();
  void executeRun(id, client).catch((err) => {
    console.error(`[runs] resume runId=${id} failed:`, err);
  });
  return c.json({ id, status: "resumed" });
});

runsRouter.get("/", async (c) => {
  const rows = await db.select().from(runs).orderBy(desc(runs.createdAt));
  const out: RunSummary[] = rows.map(serializeRun);
  return c.json(out);
});

runsRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [run] = await db.select().from(runs).where(eq(runs.id, id));
  if (!run) return c.json({ error: "not_found" }, 404);

  const cases = await db.select().from(runCases).where(eq(runCases.runId, id));
  const allAttempts = await db
    .select()
    .from(runAttempts)
    .where(eq(runAttempts.runCaseId, id))
    .limit(0); // typed; actual fetch below

  const attemptsByCase = new Map<string, typeof allAttempts>();
  for (const c of cases) {
    const a = await db.select().from(runAttempts).where(eq(runAttempts.runCaseId, c.id));
    attemptsByCase.set(c.id, a);
  }

  const aggregate = aggregateScores(
    cases.map((c) => c.scores).filter(Boolean) as never[],
  );

  const detail: RunDetail = {
    ...serializeRun(run),
    perFieldAggregate: aggregate,
    cases: cases.map((c) => ({
      id: c.id,
      runId: c.runId,
      transcriptId: c.transcriptId,
      status: c.status as never,
      prediction: c.prediction,
      scores: c.scores as never,
      hallucinations: c.hallucinations,
      schemaInvalid: !!c.schemaInvalid,
      attempts: (attemptsByCase.get(c.id) ?? []).map((a) => ({
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
      totalCostUsd: c.totalCostUsd,
      totalDurationMs: c.totalDurationMs,
      createdAt: c.createdAt.toISOString(),
      completedAt: c.completedAt?.toISOString() ?? null,
    })),
  };
  return c.json(detail);
});

runsRouter.get("/:id/events", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    const unsubscribe = runEventBus.subscribe(id, (event) => {
      stream
        .writeSSE({ event: event.type, data: JSON.stringify(event) })
        .catch(() => undefined);
    });
    stream.onAbort(() => unsubscribe());
    // Keep the stream open until the client disconnects.
    while (!stream.aborted) {
      await stream.sleep(15_000);
      await stream.writeSSE({ event: "ping", data: "{}" });
    }
  });
});

runsRouter.get("/:id/compare/:other", async (c) => {
  const idA = c.req.param("id");
  const idB = c.req.param("other");
  const [a] = await db.select().from(runs).where(eq(runs.id, idA));
  const [b] = await db.select().from(runs).where(eq(runs.id, idB));
  if (!a || !b) return c.json({ error: "not_found" }, 404);

  const casesA = await db.select().from(runCases).where(eq(runCases.runId, idA));
  const casesB = await db.select().from(runCases).where(eq(runCases.runId, idB));
  const aggA = aggregateScores(casesA.map((c) => c.scores).filter(Boolean) as never[]);
  const aggB = aggregateScores(casesB.map((c) => c.scores).filter(Boolean) as never[]);

  const fields: (keyof typeof aggA)[] = [
    "chief_complaint",
    "vitals",
    "medications_f1",
    "diagnoses_f1",
    "plan_f1",
    "follow_up",
    "overall",
  ];

  const perField = fields.map((f) => {
    const av = aggA[f];
    const bv = aggB[f];
    const delta = bv - av;
    return {
      field: f,
      a: av,
      b: bv,
      delta,
      winner:
        Math.abs(delta) < 0.005
          ? ("tie" as const)
          : delta > 0
            ? ("b" as const)
            : ("a" as const),
    };
  });

  const byT = new Map<
    string,
    { a: number | null; b: number | null }
  >();
  for (const c of casesA) {
    const o = byT.get(c.transcriptId) ?? { a: null, b: null };
    o.a = (c.scores as { overall?: number } | null)?.overall ?? null;
    byT.set(c.transcriptId, o);
  }
  for (const c of casesB) {
    const o = byT.get(c.transcriptId) ?? { a: null, b: null };
    o.b = (c.scores as { overall?: number } | null)?.overall ?? null;
    byT.set(c.transcriptId, o);
  }
  const perCase = Array.from(byT.entries())
    .map(([transcriptId, v]) => ({
      transcriptId,
      a: v.a,
      b: v.b,
      delta: v.a != null && v.b != null ? v.b - v.a : null,
    }))
    .sort((x, y) => x.transcriptId.localeCompare(y.transcriptId));

  const out: CompareView = {
    a: serializeRun(a),
    b: serializeRun(b),
    perField,
    perCase,
  };
  return c.json(out);
});

runsRouter.get("/:id/cases/:transcriptId", async (c) => {
  const id = c.req.param("id");
  const tid = c.req.param("transcriptId");
  const [r] = await db
    .select()
    .from(runCases)
    .where(eq(runCases.runId, id));
  if (!r) return c.json({ error: "not_found" }, 404);
  // Filter client-side; transcripts are 50 max so trivial cost.
  const all = await db.select().from(runCases).where(eq(runCases.runId, id));
  const target = all.find((x) => x.transcriptId === tid);
  if (!target) return c.json({ error: "not_found" }, 404);
  const attempts = await db
    .select()
    .from(runAttempts)
    .where(eq(runAttempts.runCaseId, target.id));
  return c.json({ case: target, attempts });
});
