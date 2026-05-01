import { relations } from "drizzle-orm";
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const runs = pgTable(
  "eval_runs",
  {
    id: text("id").primaryKey(),
    strategy: text("strategy").notNull(),
    model: text("model").notNull(),
    promptHash: text("prompt_hash").notNull(),
    status: text("status").notNull().default("pending"),
    datasetFilter: jsonb("dataset_filter").$type<string[] | null>(),
    totalCases: integer("total_cases").notNull().default(0),
    completedCases: integer("completed_cases").notNull().default(0),
    failedCases: integer("failed_cases").notNull().default(0),
    schemaFailureCount: integer("schema_failure_count").notNull().default(0),
    hallucinationCount: integer("hallucination_count").notNull().default(0),
    aggregateF1: doublePrecision("aggregate_f1"),
    perFieldAggregate: jsonb("per_field_aggregate"),
    totalInputTokens: integer("total_input_tokens").notNull().default(0),
    totalOutputTokens: integer("total_output_tokens").notNull().default(0),
    totalCacheReadInputTokens: integer("total_cache_read_input_tokens").notNull().default(0),
    totalCacheCreationInputTokens: integer("total_cache_creation_input_tokens")
      .notNull()
      .default(0),
    totalCostUsd: doublePrecision("total_cost_usd").notNull().default(0),
    totalDurationMs: integer("total_duration_ms").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
  },
  (t) => [index("runs_status_idx").on(t.status), index("runs_strategy_idx").on(t.strategy)],
);

export const runCases = pgTable(
  "eval_run_cases",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    transcriptId: text("transcript_id").notNull(),
    status: text("status").notNull().default("pending"),
    prediction: jsonb("prediction"),
    scores: jsonb("scores"),
    hallucinations: jsonb("hallucinations").$type<string[]>().notNull().default([]),
    schemaInvalid: integer("schema_invalid").notNull().default(0),
    totalCostUsd: doublePrecision("total_cost_usd").notNull().default(0),
    totalDurationMs: integer("total_duration_ms").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    index("run_cases_run_id_idx").on(t.runId),
    uniqueIndex("run_cases_run_transcript_uniq").on(t.runId, t.transcriptId),
  ],
);

/**
 * Idempotency cache: a successful (strategy, model, promptHash, transcriptId)
 * tuple is reusable across runs unless force=true is passed. We point at the
 * canonical case row that produced it.
 */
export const extractionCache = pgTable(
  "eval_extraction_cache",
  {
    strategy: text("strategy").notNull(),
    model: text("model").notNull(),
    promptHash: text("prompt_hash").notNull(),
    transcriptId: text("transcript_id").notNull(),
    runCaseId: text("run_case_id")
      .notNull()
      .references(() => runCases.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("extraction_cache_uniq").on(
      t.strategy,
      t.model,
      t.promptHash,
      t.transcriptId,
    ),
  ],
);

export const runAttempts = pgTable(
  "eval_run_attempts",
  {
    id: text("id").primaryKey(),
    runCaseId: text("run_case_id")
      .notNull()
      .references(() => runCases.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    request: jsonb("request").notNull(),
    response: jsonb("response").notNull(),
    toolInput: jsonb("tool_input"),
    validationErrors: jsonb("validation_errors").$type<string[] | null>(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("run_attempts_case_idx").on(t.runCaseId)],
);

export const runRelations = relations(runs, ({ many }) => ({
  cases: many(runCases),
}));

export const runCaseRelations = relations(runCases, ({ one, many }) => ({
  run: one(runs, { fields: [runCases.runId], references: [runs.id] }),
  attempts: many(runAttempts),
}));

export const runAttemptRelations = relations(runAttempts, ({ one }) => ({
  case: one(runCases, { fields: [runAttempts.runCaseId], references: [runCases.id] }),
}));
