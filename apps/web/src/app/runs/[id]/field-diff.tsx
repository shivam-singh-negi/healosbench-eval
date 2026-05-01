"use client";

import type { Diagnosis, Extraction, Medication } from "@test-evals/shared";

/**
 * Structured field-level diff for a single case.
 *
 * Scalars (chief_complaint, follow_up.*) → green if equal/close, amber if a
 * fuzzy match, red if different.
 * Arrays (medications, plan, diagnoses) → walk gold + predicted, show each
 * item with one of three statuses: matched, missing-from-prediction, extra.
 *
 * The diff is intentionally simple: it surfaces *which* fields disagree, not a
 * full character-level diff. Combined with the per-field score column above
 * and the raw JSON below, it's enough to triage a regression case.
 */
export default function FieldDiff({
  gold,
  pred,
}: {
  gold: Extraction | null;
  pred: Extraction | null;
}) {
  if (!gold || !pred) {
    return (
      <div className="text-xs text-muted-foreground">
        {!gold ? "gold not loaded yet" : "no prediction"}
      </div>
    );
  }

  return (
    <div className="text-xs grid gap-3">
      <ScalarRow
        label="chief_complaint"
        a={gold.chief_complaint}
        b={pred.chief_complaint}
      />
      <VitalsRow a={gold.vitals} b={pred.vitals} />
      <MedsRow a={gold.medications} b={pred.medications} />
      <DxRow a={gold.diagnoses} b={pred.diagnoses} />
      <PlanRow a={gold.plan} b={pred.plan} />
      <FollowUpRow a={gold.follow_up} b={pred.follow_up} />
    </div>
  );
}

function tone(status: "match" | "differ" | "missing" | "extra"): string {
  switch (status) {
    case "match":
      return "bg-emerald-500/10 border-emerald-500/40";
    case "differ":
      return "bg-rose-500/10 border-rose-500/40";
    case "missing":
      return "bg-amber-500/10 border-amber-500/40";
    case "extra":
      return "bg-sky-500/10 border-sky-500/40";
  }
}

function Header({ children }: { children: React.ReactNode }) {
  return <div className="font-semibold text-sm">{children}</div>;
}

function ScalarRow({ label, a, b }: { label: string; a: string; b: string }) {
  const status = normalize(a) === normalize(b) ? "match" : "differ";
  return (
    <div>
      <Header>{label}</Header>
      <div className={`grid grid-cols-2 gap-2 mt-1 border rounded p-2 ${tone(status)}`}>
        <div>
          <div className="text-muted-foreground">gold</div>
          <div>{a}</div>
        </div>
        <div>
          <div className="text-muted-foreground">predicted</div>
          <div>{b}</div>
        </div>
      </div>
    </div>
  );
}

function VitalsRow({ a, b }: { a: Extraction["vitals"]; b: Extraction["vitals"] }) {
  const fields: (keyof Extraction["vitals"])[] = ["bp", "hr", "temp_f", "spo2"];
  return (
    <div>
      <Header>vitals</Header>
      <div className="grid grid-cols-4 gap-1 mt-1">
        {fields.map((f) => {
          const av = a[f] as unknown;
          const bv = b[f] as unknown;
          const status = vitalsEq(f, av, bv) ? "match" : "differ";
          return (
            <div key={f} className={`border rounded p-1 ${tone(status)}`}>
              <div className="text-muted-foreground">{f}</div>
              <div>
                <span className="text-muted-foreground">g:</span> {fmt(av)}
              </div>
              <div>
                <span className="text-muted-foreground">p:</span> {fmt(bv)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MedsRow({ a, b }: { a: Medication[]; b: Medication[] }) {
  const usedB = new Set<number>();
  const matchedPairs: { g: Medication; p: Medication }[] = [];
  const missing: Medication[] = [];
  for (const g of a) {
    let found = -1;
    for (let i = 0; i < b.length; i++) {
      if (usedB.has(i)) continue;
      if (
        normalize(b[i]!.name).includes(normalize(g.name).slice(0, 5)) ||
        normalize(g.name).includes(normalize(b[i]!.name).slice(0, 5))
      ) {
        found = i;
        break;
      }
    }
    if (found < 0) missing.push(g);
    else {
      usedB.add(found);
      matchedPairs.push({ g, p: b[found]! });
    }
  }
  const extra = b.filter((_, i) => !usedB.has(i));

  return (
    <div>
      <Header>
        medications <span className="text-muted-foreground">(gold {a.length} · pred {b.length})</span>
      </Header>
      <div className="grid gap-1 mt-1">
        {matchedPairs.map(({ g, p }, i) => {
          const allMatch =
            normalize(g.name) === normalize(p.name) &&
            normalize(g.dose ?? "") === normalize(p.dose ?? "") &&
            normalize(g.frequency ?? "") === normalize(p.frequency ?? "");
          return (
            <div key={`m${i}`} className={`border rounded p-1 ${tone(allMatch ? "match" : "differ")}`}>
              <div>
                <span className="text-muted-foreground">g:</span> {medFmt(g)}
              </div>
              <div>
                <span className="text-muted-foreground">p:</span> {medFmt(p)}
              </div>
            </div>
          );
        })}
        {missing.map((g, i) => (
          <div key={`mi${i}`} className={`border rounded p-1 ${tone("missing")}`}>
            <span className="text-muted-foreground">missing from prediction:</span> {medFmt(g)}
          </div>
        ))}
        {extra.map((p, i) => (
          <div key={`me${i}`} className={`border rounded p-1 ${tone("extra")}`}>
            <span className="text-muted-foreground">extra in prediction:</span> {medFmt(p)}
          </div>
        ))}
      </div>
    </div>
  );
}

function DxRow({ a, b }: { a: Diagnosis[]; b: Diagnosis[] }) {
  const usedB = new Set<number>();
  const rows: { g: Diagnosis | null; p: Diagnosis | null; status: "match" | "differ" | "missing" | "extra" }[] = [];
  for (const g of a) {
    let found = -1;
    for (let i = 0; i < b.length; i++) {
      if (usedB.has(i)) continue;
      const overlap =
        normalize(b[i]!.description).includes(normalize(g.description).split(" ")[0] ?? "") ||
        normalize(g.description).includes(normalize(b[i]!.description).split(" ")[0] ?? "");
      if (overlap) {
        found = i;
        break;
      }
    }
    if (found < 0) rows.push({ g, p: null, status: "missing" });
    else {
      usedB.add(found);
      const exact =
        normalize(g.description) === normalize(b[found]!.description) &&
        (g.icd10 ?? "") === (b[found]!.icd10 ?? "");
      rows.push({ g, p: b[found]!, status: exact ? "match" : "differ" });
    }
  }
  for (let i = 0; i < b.length; i++) {
    if (!usedB.has(i)) rows.push({ g: null, p: b[i]!, status: "extra" });
  }
  return (
    <div>
      <Header>
        diagnoses <span className="text-muted-foreground">(gold {a.length} · pred {b.length})</span>
      </Header>
      <div className="grid gap-1 mt-1">
        {rows.map((r, i) => (
          <div key={`d${i}`} className={`border rounded p-1 ${tone(r.status)}`}>
            {r.g ? (
              <div>
                <span className="text-muted-foreground">g:</span> {dxFmt(r.g)}
              </div>
            ) : null}
            {r.p ? (
              <div>
                <span className="text-muted-foreground">p:</span> {dxFmt(r.p)}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function PlanRow({ a, b }: { a: string[]; b: string[] }) {
  const usedB = new Set<number>();
  const rows: { g: string | null; p: string | null; status: "match" | "differ" | "missing" | "extra" }[] = [];
  for (const g of a) {
    let found = -1;
    for (let i = 0; i < b.length; i++) {
      if (usedB.has(i)) continue;
      const overlapTokens = countSharedTokens(g, b[i]!);
      if (overlapTokens >= 2) {
        found = i;
        break;
      }
    }
    if (found < 0) rows.push({ g, p: null, status: "missing" });
    else {
      usedB.add(found);
      rows.push({
        g,
        p: b[found]!,
        status: normalize(g) === normalize(b[found]!) ? "match" : "differ",
      });
    }
  }
  for (let i = 0; i < b.length; i++) {
    if (!usedB.has(i)) rows.push({ g: null, p: b[i]!, status: "extra" });
  }
  return (
    <div>
      <Header>
        plan <span className="text-muted-foreground">(gold {a.length} · pred {b.length})</span>
      </Header>
      <div className="grid gap-1 mt-1">
        {rows.map((r, i) => (
          <div key={`p${i}`} className={`border rounded p-1 ${tone(r.status)}`}>
            {r.g ? (
              <div>
                <span className="text-muted-foreground">g:</span> {r.g}
              </div>
            ) : null}
            {r.p ? (
              <div>
                <span className="text-muted-foreground">p:</span> {r.p}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function FollowUpRow({
  a,
  b,
}: {
  a: Extraction["follow_up"];
  b: Extraction["follow_up"];
}) {
  const intervalSame = a.interval_days === b.interval_days;
  const reasonSame = (a.reason ?? null) === (b.reason ?? null);
  return (
    <div>
      <Header>follow_up</Header>
      <div className="grid grid-cols-2 gap-1 mt-1">
        <div className={`border rounded p-1 ${tone(intervalSame ? "match" : "differ")}`}>
          <div className="text-muted-foreground">interval_days</div>
          <div>g: {fmt(a.interval_days)}</div>
          <div>p: {fmt(b.interval_days)}</div>
        </div>
        <div className={`border rounded p-1 ${tone(reasonSame ? "match" : "differ")}`}>
          <div className="text-muted-foreground">reason</div>
          <div>g: {fmt(a.reason)}</div>
          <div>p: {fmt(b.reason)}</div>
        </div>
      </div>
    </div>
  );
}

function normalize(s: string | null | undefined): string {
  if (!s) return "";
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  return String(v);
}

function medFmt(m: Medication): string {
  return [m.name, m.dose, m.frequency, m.route].filter(Boolean).join(" · ");
}

function dxFmt(d: Diagnosis): string {
  return d.icd10 ? `${d.description} [${d.icd10}]` : d.description;
}

function countSharedTokens(a: string, b: string): number {
  const sa = new Set(normalize(a).split(" ").filter(Boolean));
  const sb = new Set(normalize(b).split(" ").filter(Boolean));
  let n = 0;
  for (const t of sa) if (sb.has(t)) n++;
  return n;
}

function vitalsEq(field: keyof Extraction["vitals"], a: unknown, b: unknown): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (field === "temp_f") {
    return Math.abs(Number(a) - Number(b)) <= 0.2;
  }
  return a === b;
}
