/**
 * Integration tests for resumability + idempotency.
 *
 * These exercise the actual DB-backed runner. They run when DATABASE_URL
 * is set (e.g. local dev, CI with Postgres). Otherwise we skip the suite
 * cleanly — the unit-tested parts are still covered.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

// Integration suite gated on an explicit opt-in flag, separate from the
// stubbed DATABASE_URL we set for unit tests in tests/setup.ts.
const HAS_DB = process.env.RUN_INTEGRATION_TESTS === "1";

if (!HAS_DB) {
  describe.skip("runner integration (DATABASE_URL unset)", () => {
    it("requires Postgres", () => undefined);
  });
} else {
  await runIntegrationSuite();
}

async function runIntegrationSuite() {
  const { randomUUID } = await import("node:crypto");
  const { db } = await import("../packages/db/src/index");
  const {
    extractionCache,
    runAttempts,
    runCases,
    runs,
  } = await import("../packages/db/src/schema/eval");
  const { and, eq } = await import("drizzle-orm");
  const { hashStrategy, getStrategy } = await import("../packages/llm/src/strategies");
  const { createRun, executeRun } = await import(
    "../apps/server/src/services/runner.service"
  );
  const fixtureGoldNS = await import("../packages/shared/src/dataset");

  const validToolInput = {
    chief_complaint: "test",
    vitals: { bp: null, hr: null, temp_f: null, spo2: null },
    medications: [],
    diagnoses: [],
    plan: ["follow up"],
    follow_up: { interval_days: null, reason: null },
  };

  const filter = ["case_001", "case_002", "case_003"];
  const strategy = "zero_shot" as const;
  const promptHash = hashStrategy(getStrategy(strategy));

  let runId1: string;
  let runId2: string;

  // Counted client we can inspect across calls.
  function makeCountedClient() {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      async call() {
        calls++;
        return {
          response: {
            content: [
              {
                type: "tool_use",
                id: "t_" + Math.random().toString(36).slice(2),
                name: "record_extraction",
                input: validToolInput,
              },
            ],
          } as never,
          toolInput: validToolInput,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        };
      },
    };
  }

  beforeAll(async () => {
    // Wipe any prior test state for a clean slate.
    await db
      .delete(extractionCache)
      .where(eq(extractionCache.promptHash, promptHash));
  });

  afterAll(async () => {
    if (runId1) await db.delete(runs).where(eq(runs.id, runId1));
    if (runId2) await db.delete(runs).where(eq(runs.id, runId2));
  });

  describe("resumability", () => {
    it("only processes cases where status='pending' (resume invariant)", async () => {
      const client = makeCountedClient();
      runId1 = await createRun({
        strategy,
        model: "claude-haiku-4-5-20251001",
        datasetFilter: filter,
        client: client as never,
      });

      // Simulate a partial prior run: mark case_001 completed already.
      const cases = await db.select().from(runCases).where(eq(runCases.runId, runId1));
      const c001 = cases.find((c) => c.transcriptId === "case_001")!;
      await db
        .update(runCases)
        .set({
          status: "completed",
          prediction: validToolInput as never,
          scores: { overall: 1, chief_complaint: 1, vitals: 1, plan: { f1: 1, precision: 1, recall: 1 }, medications: { f1: 1, precision: 1, recall: 1 }, diagnoses: { f1: 1, precision: 1, recall: 1, icd10_bonus: 0 }, follow_up: 1 } as never,
        })
        .where(eq(runCases.id, c001.id));

      await executeRun(runId1, client as never);

      // FakeClient should have been called exactly twice (for case_002 + case_003),
      // not three times — case_001 was already 'completed'.
      expect(client.calls).toBe(2);

      const finalCases = await db.select().from(runCases).where(eq(runCases.runId, runId1));
      expect(finalCases.every((c) => c.status === "completed")).toBe(true);
    });
  });

  describe("idempotency", () => {
    it("a re-run with same (strategy, model, promptHash) hits the cache", async () => {
      const client = makeCountedClient();
      runId2 = await createRun({
        strategy,
        model: "claude-haiku-4-5-20251001",
        datasetFilter: filter,
        client: client as never,
      });
      await executeRun(runId2, client as never);
      // 0 LLM calls — every case had a cached prediction from runId1.
      expect(client.calls).toBe(0);

      const cases = await db.select().from(runCases).where(eq(runCases.runId, runId2));
      expect(cases.every((c) => c.status === "completed")).toBe(true);
    });
  });
}
