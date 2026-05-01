import { z } from "zod";

const bp = z
  .string()
  .regex(/^[0-9]{2,3}\/[0-9]{2,3}$/, "bp must look like systolic/diastolic, e.g. 122/78")
  .nullable();

export const VitalsSchema = z.object({
  bp,
  hr: z.number().int().min(20).max(250).nullable(),
  temp_f: z.number().min(90).max(110).nullable(),
  spo2: z.number().int().min(50).max(100).nullable(),
});

export const MedicationSchema = z.object({
  name: z.string().min(1),
  dose: z.string().nullable(),
  frequency: z.string().nullable(),
  route: z.string().nullable(),
});

export const DiagnosisSchema = z.object({
  description: z.string().min(1),
  icd10: z
    .string()
    .regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/)
    .optional(),
});

export const FollowUpSchema = z.object({
  interval_days: z.number().int().min(0).max(730).nullable(),
  reason: z.string().nullable(),
});

export const ExtractionSchema = z.object({
  chief_complaint: z.string().min(1),
  vitals: VitalsSchema,
  medications: z.array(MedicationSchema),
  diagnoses: z.array(DiagnosisSchema),
  plan: z.array(z.string().min(1)),
  follow_up: FollowUpSchema,
});

export type Vitals = z.infer<typeof VitalsSchema>;
export type Medication = z.infer<typeof MedicationSchema>;
export type Diagnosis = z.infer<typeof DiagnosisSchema>;
export type FollowUp = z.infer<typeof FollowUpSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;

/**
 * The JSON Schema we hand to Anthropic's tool-use input_schema.
 * Mirrors data/schema.json. Kept hand-written (not generated) so we
 * stay in lockstep with the spec the assignment locks down.
 */
export const EXTRACTION_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["chief_complaint", "vitals", "medications", "diagnoses", "plan", "follow_up"],
  properties: {
    chief_complaint: { type: "string", minLength: 1 },
    vitals: {
      type: "object",
      additionalProperties: false,
      required: ["bp", "hr", "temp_f", "spo2"],
      properties: {
        bp: { type: ["string", "null"], pattern: "^[0-9]{2,3}/[0-9]{2,3}$" },
        hr: { type: ["integer", "null"], minimum: 20, maximum: 250 },
        temp_f: { type: ["number", "null"], minimum: 90, maximum: 110 },
        spo2: { type: ["integer", "null"], minimum: 50, maximum: 100 },
      },
    },
    medications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "dose", "frequency", "route"],
        properties: {
          name: { type: "string", minLength: 1 },
          dose: { type: ["string", "null"] },
          frequency: { type: ["string", "null"] },
          route: { type: ["string", "null"] },
        },
      },
    },
    diagnoses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description"],
        properties: {
          description: { type: "string", minLength: 1 },
          icd10: { type: "string", pattern: "^[A-Z][0-9]{2}(\\.[0-9A-Z]{1,4})?$" },
        },
      },
    },
    plan: { type: "array", items: { type: "string", minLength: 1 } },
    follow_up: {
      type: "object",
      additionalProperties: false,
      required: ["interval_days", "reason"],
      properties: {
        interval_days: { type: ["integer", "null"], minimum: 0, maximum: 730 },
        reason: { type: ["string", "null"] },
      },
    },
  },
} as const;

export const STRATEGIES = ["zero_shot", "few_shot", "cot"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const RUN_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const CASE_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];
