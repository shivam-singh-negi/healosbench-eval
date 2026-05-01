import { describe, expect, it } from "bun:test";

import {
  detectHallucinations,
  evaluate,
  medMatches,
  setF1,
} from "../apps/server/src/services/evaluate.service";
import type { Extraction } from "../packages/shared/src/schema";

const baseExtraction: Extraction = {
  chief_complaint: "sore throat",
  vitals: { bp: null, hr: null, temp_f: null, spo2: null },
  medications: [],
  diagnoses: [],
  plan: [],
  follow_up: { interval_days: null, reason: null },
};

describe("setF1", () => {
  it("perfect match yields F1 = 1", () => {
    const r = setF1(["a", "b", "c"], ["a", "b", "c"], (x, y) => x === y);
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(1);
    expect(r.f1).toBe(1);
  });

  it("partial match computes correct precision/recall/F1", () => {
    // pred=[a,b,d], gold=[a,b,c]: TP=2, FP=1, FN=1 ⇒ P=2/3, R=2/3, F1=2/3
    const r = setF1(["a", "b", "d"], ["a", "b", "c"], (x, y) => x === y);
    expect(r.precision).toBeCloseTo(2 / 3, 5);
    expect(r.recall).toBeCloseTo(2 / 3, 5);
    expect(r.f1).toBeCloseTo(2 / 3, 5);
  });

  it("both empty ⇒ F1 = 1 (no items to confuse)", () => {
    const r = setF1<number>([], [], () => true);
    expect(r.f1).toBe(1);
  });

  it("only one side empty ⇒ F1 = 0", () => {
    expect(setF1(["a"], [], (x, y) => x === y).f1).toBe(0);
    expect(setF1([], ["a"], (x, y) => x === y).f1).toBe(0);
  });
});

describe("medMatches (fuzzy + canonicalized frequency)", () => {
  it("matches BID == 'twice daily', '10 mg' == '10mg'", () => {
    expect(
      medMatches(
        { name: "amoxicillin", dose: "10 mg", frequency: "BID", route: "PO" },
        { name: "amoxicillin", dose: "10mg", frequency: "twice daily", route: "PO" },
      ),
    ).toBe(true);
  });

  it("does not match different doses", () => {
    expect(
      medMatches(
        { name: "amoxicillin", dose: "500 mg", frequency: "BID", route: "PO" },
        { name: "amoxicillin", dose: "250 mg", frequency: "BID", route: "PO" },
      ),
    ).toBe(false);
  });

  it("tolerates a typo in name (fuzzy)", () => {
    expect(
      medMatches(
        { name: "amoxicilin", dose: "500 mg", frequency: "tid", route: "PO" },
        { name: "amoxicillin", dose: "500 mg", frequency: "three times daily", route: "PO" },
      ),
    ).toBe(true);
  });
});

describe("hallucination detector", () => {
  const transcript =
    "Doctor: Throat is red. Plan is ibuprofen 400 mg every 6 hours. Follow up in 7 days.";

  it("flags a medication that does not appear in the transcript", () => {
    const pred: Extraction = {
      ...baseExtraction,
      medications: [
        { name: "ciprofloxacin", dose: "500 mg", frequency: "bid", route: "PO" },
      ],
    };
    const flags = detectHallucinations(pred, transcript);
    expect(flags.some((f) => f.includes("ciprofloxacin"))).toBe(true);
  });

  it("does not flag a medication that does appear", () => {
    const pred: Extraction = {
      ...baseExtraction,
      medications: [{ name: "ibuprofen", dose: "400 mg", frequency: "q6h", route: "PO" }],
    };
    const flags = detectHallucinations(pred, transcript);
    expect(flags.some((f) => f.startsWith("medications"))).toBe(false);
  });
});

describe("evaluate (end-to-end on a fixture)", () => {
  it("perfect prediction yields perfect scores", () => {
    const gold: Extraction = {
      chief_complaint: "ear pain for three days",
      vitals: { bp: "124/80", hr: 90, temp_f: 99.1, spo2: 99 },
      medications: [
        { name: "amoxicillin", dose: "500 mg", frequency: "tid", route: "PO" },
      ],
      diagnoses: [{ description: "acute otitis media", icd10: "H66.90" }],
      plan: ["amoxicillin 500 mg three times daily for 7 days"],
      follow_up: { interval_days: 14, reason: "if symptoms persist" },
    };
    const transcript =
      "ear pain for three days. amoxicillin 500 mg three times daily for 7 days. acute otitis media. if symptoms persist return in 14 days";
    const r = evaluate(gold, gold, transcript);
    expect(r.scores.overall).toBeCloseTo(1, 2);
    expect(r.scores.medications.f1).toBe(1);
    expect(r.scores.diagnoses.icd10_bonus).toBe(1);
  });

  it("temp_f within ±0.2 °F still counts as a match", () => {
    const gold: Extraction = {
      ...baseExtraction,
      vitals: { bp: null, hr: null, temp_f: 99.4, spo2: null },
    };
    const pred: Extraction = {
      ...baseExtraction,
      vitals: { bp: null, hr: null, temp_f: 99.5, spo2: null },
    };
    const r = evaluate(pred, gold, "");
    expect(r.scores.vitals).toBe(1);
  });
});
