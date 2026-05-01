import type { Diagnosis, Extraction, Medication, Vitals } from "@test-evals/shared";

import {
  canonicalizeDose,
  canonicalizeFrequency,
  fuzzyScore,
  normalizeText,
  ratio,
  tokenSetRatio,
} from "./text";

const FUZZY_MED_NAME_THRESHOLD = 0.85;
const FUZZY_DIAGNOSIS_THRESHOLD = 0.7;
const FUZZY_PLAN_THRESHOLD = 0.6;
const FUZZY_GROUND_THRESHOLD = 0.78;
const TEMP_TOLERANCE_F = 0.2;

export interface PrfScore {
  precision: number;
  recall: number;
  f1: number;
}

export interface DiagnosisPrfScore extends PrfScore {
  /** Fraction of matched diagnoses where icd10 also matched (0 if no matches). */
  icd10_bonus: number;
}

export interface FieldScores {
  chief_complaint: number;
  vitals: number;
  medications: PrfScore;
  diagnoses: DiagnosisPrfScore;
  plan: PrfScore;
  follow_up: number;
  overall: number;
}

export interface EvaluationResult {
  scores: FieldScores;
  hallucinations: string[];
}

export function evaluate(
  prediction: Extraction,
  gold: Extraction,
  transcript: string,
): EvaluationResult {
  const chief_complaint = scoreChiefComplaint(prediction.chief_complaint, gold.chief_complaint);
  const vitals = scoreVitals(prediction.vitals, gold.vitals);
  const medications = scoreMedications(prediction.medications, gold.medications);
  const diagnoses = scoreDiagnoses(prediction.diagnoses, gold.diagnoses);
  const plan = scorePlan(prediction.plan, gold.plan);
  const follow_up = scoreFollowUp(prediction.follow_up, gold.follow_up);

  const overall =
    (chief_complaint + vitals + medications.f1 + diagnoses.f1 + plan.f1 + follow_up) / 6;

  const hallucinations = detectHallucinations(prediction, transcript);

  return {
    scores: {
      chief_complaint,
      vitals,
      medications,
      diagnoses,
      plan,
      follow_up,
      overall,
    },
    hallucinations,
  };
}

export function scoreChiefComplaint(pred: string, gold: string): number {
  return fuzzyScore(pred, gold);
}

export function scoreVitals(pred: Vitals, gold: Vitals): number {
  // Per-field 0/1 with numeric tolerance, averaged across the 4 fields.
  const checks: number[] = [];

  checks.push(eq(pred.bp, gold.bp) ? 1 : 0);
  checks.push(numericEq(pred.hr, gold.hr, 0) ? 1 : 0);
  checks.push(numericEq(pred.temp_f, gold.temp_f, TEMP_TOLERANCE_F) ? 1 : 0);
  checks.push(numericEq(pred.spo2, gold.spo2, 0) ? 1 : 0);

  return checks.reduce((s, x) => s + x, 0) / checks.length;
}

export function scoreMedications(pred: Medication[], gold: Medication[]): PrfScore {
  return setF1(pred, gold, medMatches);
}

export function medMatches(a: Medication, b: Medication): boolean {
  if (fuzzyScore(a.name, b.name) < FUZZY_MED_NAME_THRESHOLD) return false;
  if (canonicalizeDose(a.dose) !== canonicalizeDose(b.dose)) return false;
  const fa = canonicalizeFrequency(a.frequency);
  const fb = canonicalizeFrequency(b.frequency);
  // Frequency: canonical-equal OR token-set similarity above threshold.
  if (fa === fb) return true;
  return tokenSetRatio(fa, fb) >= 0.6;
}

export function scoreDiagnoses(pred: Diagnosis[], gold: Diagnosis[]): DiagnosisPrfScore {
  const base = setF1(pred, gold, (a, b) => fuzzyScore(a.description, b.description) >= FUZZY_DIAGNOSIS_THRESHOLD);

  // ICD-10 bonus: among matched gold diagnoses, what fraction also had an
  // icd10 code that exactly matched the prediction's?
  const matchedPairs: { p: Diagnosis; g: Diagnosis }[] = [];
  const used = new Set<number>();
  for (const p of pred) {
    for (let i = 0; i < gold.length; i++) {
      if (used.has(i)) continue;
      if (fuzzyScore(p.description, gold[i]!.description) >= FUZZY_DIAGNOSIS_THRESHOLD) {
        matchedPairs.push({ p, g: gold[i]! });
        used.add(i);
        break;
      }
    }
  }
  let icdHits = 0;
  let icdEligible = 0;
  for (const { p, g } of matchedPairs) {
    if (g.icd10) {
      icdEligible++;
      if (p.icd10 && p.icd10.toUpperCase() === g.icd10.toUpperCase()) icdHits++;
    }
  }
  const icd10_bonus = icdEligible === 0 ? 0 : icdHits / icdEligible;
  return { ...base, icd10_bonus };
}

export function scorePlan(pred: string[], gold: string[]): PrfScore {
  return setF1(pred, gold, (a, b) => fuzzyScore(a, b) >= FUZZY_PLAN_THRESHOLD);
}

export function scoreFollowUp(
  pred: Extraction["follow_up"],
  gold: Extraction["follow_up"],
): number {
  const intervalOk = pred.interval_days === gold.interval_days ? 1 : 0;
  const reasonOk =
    pred.reason == null && gold.reason == null
      ? 1
      : pred.reason && gold.reason
        ? fuzzyScore(pred.reason, gold.reason)
        : 0;
  return (intervalOk + reasonOk) / 2;
}

/**
 * Generic set-precision/recall/F1: greedy matching with a user-supplied
 * predicate. Each gold item can match at most one predicted item.
 */
export function setF1<T>(
  pred: T[],
  gold: T[],
  matches: (a: T, b: T) => boolean,
): PrfScore {
  if (pred.length === 0 && gold.length === 0) {
    return { precision: 1, recall: 1, f1: 1 };
  }
  const usedGold = new Set<number>();
  let tp = 0;
  for (const p of pred) {
    for (let i = 0; i < gold.length; i++) {
      if (usedGold.has(i)) continue;
      if (matches(p, gold[i]!)) {
        usedGold.add(i);
        tp++;
        break;
      }
    }
  }
  const precision = pred.length === 0 ? 0 : tp / pred.length;
  const recall = gold.length === 0 ? 0 : tp / gold.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function eq<T>(a: T, b: T): boolean {
  return a === b;
}

function numericEq(
  a: number | null | undefined,
  b: number | null | undefined,
  tol: number,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= tol;
}

/**
 * Hallucination detector: every leaf string the model emits must have a
 * corresponding fuzzy-grounded mention in the transcript.
 *
 * - For free-form strings (chief_complaint, plan items, diagnosis description,
 *   follow_up.reason): require token-set similarity ≥ FUZZY_GROUND_THRESHOLD
 *   against any sliding window of the transcript of comparable length, OR
 *   substring-after-normalization.
 * - For medication names: require the normalized name (or any token of it) to
 *   appear in the normalized transcript. Generic names are short, so this is
 *   simply a contains-check after normalization.
 * - Vitals values are numbers and we trust the schema; we only flag *strings*.
 *
 * Returns a list of hallucination labels like "medications[1].name=foo".
 */
export function detectHallucinations(pred: Extraction, transcript: string): string[] {
  const flags: string[] = [];
  const ntrans = normalizeText(transcript);
  if (!ntrans) return flags;

  if (!groundedFuzzy(pred.chief_complaint, ntrans)) {
    flags.push(`chief_complaint="${pred.chief_complaint}"`);
  }
  for (let i = 0; i < pred.medications.length; i++) {
    const m = pred.medications[i]!;
    if (!groundedSubstring(m.name, ntrans)) {
      flags.push(`medications[${i}].name="${m.name}"`);
    }
  }
  for (let i = 0; i < pred.diagnoses.length; i++) {
    const d = pred.diagnoses[i]!;
    if (!groundedFuzzy(d.description, ntrans)) {
      flags.push(`diagnoses[${i}].description="${d.description}"`);
    }
  }
  for (let i = 0; i < pred.plan.length; i++) {
    const item = pred.plan[i]!;
    if (!groundedFuzzy(item, ntrans)) {
      flags.push(`plan[${i}]="${item}"`);
    }
  }
  if (pred.follow_up.reason && !groundedFuzzy(pred.follow_up.reason, ntrans)) {
    flags.push(`follow_up.reason="${pred.follow_up.reason}"`);
  }
  return flags;
}

function groundedSubstring(value: string | null | undefined, normalizedTranscript: string): boolean {
  if (!value) return true;
  const v = normalizeText(value);
  if (!v) return true;
  return normalizedTranscript.includes(v);
}

function groundedFuzzy(value: string, normalizedTranscript: string): boolean {
  const v = normalizeText(value);
  if (!v) return true;
  if (normalizedTranscript.includes(v)) return true;

  // Token-set: every claim token must be present in the transcript token set.
  // If most tokens are present we accept; this is the cheap approximation
  // that catches paraphrases of clinical findings.
  const tt = new Set(normalizedTranscript.split(" "));
  const vt = v.split(" ");
  let hits = 0;
  for (const t of vt) if (tt.has(t)) hits++;
  if (vt.length > 0 && hits / vt.length >= FUZZY_GROUND_THRESHOLD) return true;

  // Last resort: edit-ratio against the closest sliding window.
  const windowSize = v.length;
  const t = normalizedTranscript;
  const step = Math.max(1, Math.floor(windowSize / 4));
  for (let i = 0; i < t.length; i += step) {
    const window = t.slice(i, i + windowSize + 8);
    if (ratio(v, window) >= FUZZY_GROUND_THRESHOLD) return true;
  }
  return false;
}
