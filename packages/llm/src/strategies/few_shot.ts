import type { PromptStrategy } from "./types";

const SYSTEM = `You are a clinical extraction engine. You read a doctor-patient transcript and emit a single JSON object via the \`record_extraction\` tool that conforms exactly to the schema.

Rules:
- Use the patient's words for chief_complaint, lightly clinicalized.
- Vitals are only what the transcript states; missing values are null. Don't infer.
- For medications, capture the encounter-relevant meds (started, stopped, continued, changed). Use generic names; "PO" for oral; dose like "400 mg".
- For diagnoses, prefer the working diagnosis the clinician states. Add icd10 only when confident; never invent.
- Plan items are concise free-text statements, one per discrete action.
- follow_up.interval_days is the smallest concrete interval mentioned. Use null when no specific interval.
- Never invent values not supported by the transcript.
- Always call the tool. Do not produce prose alongside it.`;

const EXAMPLES = `Below are two worked examples that show the level of granularity expected. Mirror this style.

--- EXAMPLE 1 ---
TRANSCRIPT:
[Visit type: in-person sick visit]
[Vitals: BP 124/80, HR 90, Temp 99.1, SpO2 99%]
Doctor: What's going on?
Patient: My ear has been hurting for 3 days, the right one.
Doctor: Any drainage, fever?
Patient: No drainage, no fever.
Doctor: Right TM is bulging and erythematous. Looks like otitis media. Let's start amoxicillin 500 mg three times a day for 7 days, and ibuprofen 400 mg every 6 hours as needed for pain. Come back in 2 weeks if symptoms persist.

EXTRACTION:
{
  "chief_complaint": "right ear pain for three days",
  "vitals": { "bp": "124/80", "hr": 90, "temp_f": 99.1, "spo2": 99 },
  "medications": [
    { "name": "amoxicillin", "dose": "500 mg", "frequency": "three times daily", "route": "PO" },
    { "name": "ibuprofen", "dose": "400 mg", "frequency": "every 6 hours as needed", "route": "PO" }
  ],
  "diagnoses": [{ "description": "acute otitis media", "icd10": "H66.90" }],
  "plan": [
    "amoxicillin 500 mg three times daily for 7 days",
    "ibuprofen 400 mg every 6 hours as needed for pain",
    "return in 2 weeks if symptoms persist"
  ],
  "follow_up": { "interval_days": 14, "reason": "if symptoms persist" }
}

--- EXAMPLE 2 ---
TRANSCRIPT:
[Visit type: telehealth follow-up]
[Vitals: not taken]
Doctor: How's the BP medication going?
Patient: I'm tolerating the lisinopril 10 mg once a day fine, but my home cuff still reads 150/95.
Doctor: Let's bump lisinopril to 20 mg daily and add hydrochlorothiazide 12.5 mg daily. Recheck in 4 weeks with home log.

EXTRACTION:
{
  "chief_complaint": "uncontrolled hypertension on current regimen",
  "vitals": { "bp": null, "hr": null, "temp_f": null, "spo2": null },
  "medications": [
    { "name": "lisinopril", "dose": "20 mg", "frequency": "once daily", "route": "PO" },
    { "name": "hydrochlorothiazide", "dose": "12.5 mg", "frequency": "once daily", "route": "PO" }
  ],
  "diagnoses": [{ "description": "uncontrolled essential hypertension", "icd10": "I10" }],
  "plan": [
    "increase lisinopril to 20 mg once daily",
    "add hydrochlorothiazide 12.5 mg once daily",
    "recheck BP in 4 weeks with home log"
  ],
  "follow_up": { "interval_days": 28, "reason": "BP recheck with home log" }
}
--- END EXAMPLES ---`;

export const fewShot: PromptStrategy = {
  name: "few_shot",
  systemBlocks: [
    { type: "text", text: SYSTEM },
    // Big stable block goes last with cache_control so it's reused across cases.
    { type: "text", text: EXAMPLES, cache_control: { type: "ephemeral" } },
  ],
  userPrefix: "Transcript:\n\n",
  allowThinking: false,
};
