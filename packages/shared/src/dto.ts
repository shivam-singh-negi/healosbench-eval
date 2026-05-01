import { z } from "zod";

import { CASE_STATUSES, RUN_STATUSES, STRATEGIES, type Extraction } from "./schema";

/** Browser-safe shape — file IO lives in `@test-evals/shared/dataset`. */
export interface DatasetCase {
  transcriptId: string;
  transcript: string;
  gold: Extraction;
}

export const StartRunRequestSchema = z.object({
  strategy: z.enum(STRATEGIES),
  model: z.string().min(1),
  dataset_filter: z.array(z.string()).optional(),
  force: z.boolean().optional(),
  cost_cap_usd: z.number().positive().optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export interface AttemptDTO {
  id: string;
  attempt: number;
  request: unknown;
  response: unknown;
  validationErrors: string[] | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  durationMs: number;
  createdAt: string;
}

export interface FieldScores {
  chief_complaint: number;
  vitals: number;
  medications: { precision: number; recall: number; f1: number };
  diagnoses: { precision: number; recall: number; f1: number; icd10_bonus: number };
  plan: { precision: number; recall: number; f1: number };
  follow_up: number;
  overall: number;
}

export interface CaseDTO {
  id: string;
  runId: string;
  transcriptId: string;
  status: (typeof CASE_STATUSES)[number];
  prediction: unknown | null;
  scores: FieldScores | null;
  hallucinations: string[];
  schemaInvalid: boolean;
  attempts: AttemptDTO[];
  totalCostUsd: number;
  totalDurationMs: number;
  createdAt: string;
  completedAt: string | null;
}

export interface RunSummary {
  id: string;
  strategy: (typeof STRATEGIES)[number];
  model: string;
  promptHash: string;
  status: (typeof RUN_STATUSES)[number];
  totalCases: number;
  completedCases: number;
  failedCases: number;
  schemaFailureCount: number;
  hallucinationCount: number;
  aggregateF1: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunDetail extends RunSummary {
  cases: CaseDTO[];
  perFieldAggregate: AggregateScores;
}

export interface AggregateScores {
  chief_complaint: number;
  vitals: number;
  medications_f1: number;
  diagnoses_f1: number;
  plan_f1: number;
  follow_up: number;
  overall: number;
}

export interface CompareView {
  a: RunSummary;
  b: RunSummary;
  perField: {
    field: string;
    a: number;
    b: number;
    delta: number;
    winner: "a" | "b" | "tie";
  }[];
  perCase: {
    transcriptId: string;
    a: number | null;
    b: number | null;
    delta: number | null;
  }[];
}

export type RunEvent =
  | { type: "case_started"; transcriptId: string }
  | { type: "case_completed"; transcriptId: string; case: CaseDTO }
  | { type: "case_failed"; transcriptId: string; error: string }
  | { type: "run_completed"; run: RunSummary }
  | { type: "run_failed"; runId: string; error: string };
