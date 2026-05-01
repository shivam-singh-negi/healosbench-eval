"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type { CompareView, RunSummary } from "@test-evals/shared";

import { api } from "@/lib/api";

function pct(n: number | null | undefined): string {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}

export default function ComparePage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");
  const [view, setView] = useState<CompareView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listRuns().then(setRuns).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!a || !b || a === b) {
      setView(null);
      return;
    }
    api.compare(a, b).then(setView).catch((e) => setError(String(e)));
  }, [a, b]);

  const completed = useMemo(
    () => (runs ?? []).filter((r) => r.status === "completed"),
    [runs],
  );

  if (error) return <div className="p-4 text-red-500">{error}</div>;
  if (!runs) return <div className="p-4">loading…</div>;

  return (
    <div className="container mx-auto max-w-6xl p-4">
      <h1 className="text-xl font-semibold mb-4">Compare runs</h1>
      <div className="flex gap-3 items-end mb-6">
        <label className="grid gap-1">
          <span className="text-sm">A</span>
          <select
            className="border rounded p-2 bg-background min-w-72"
            value={a}
            onChange={(e) => setA(e.target.value)}
          >
            <option value="">select…</option>
            {completed.map((r) => (
              <option key={r.id} value={r.id}>
                {r.strategy} · {r.promptHash} · F1 {pct(r.aggregateF1)}
              </option>
            ))}
          </select>
        </label>
        <span className="text-2xl pb-1">↔</span>
        <label className="grid gap-1">
          <span className="text-sm">B</span>
          <select
            className="border rounded p-2 bg-background min-w-72"
            value={b}
            onChange={(e) => setB(e.target.value)}
          >
            <option value="">select…</option>
            {completed.map((r) => (
              <option key={r.id} value={r.id}>
                {r.strategy} · {r.promptHash} · F1 {pct(r.aggregateF1)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!view ? (
        <p className="text-muted-foreground">select two completed runs.</p>
      ) : (
        <CompareDetails view={view} />
      )}

      <div className="mt-6 text-sm">
        <Link className="underline" href="/runs">
          ← back to runs
        </Link>
      </div>
    </div>
  );
}

function CompareDetails({ view }: { view: CompareView }) {
  const winsA = view.perField.filter((f) => f.winner === "a").length;
  const winsB = view.perField.filter((f) => f.winner === "b").length;
  const aBetterCases = view.perCase.filter((c) => c.delta != null && c.delta < -0.05);
  const bBetterCases = view.perCase.filter((c) => c.delta != null && c.delta > 0.05);

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3">
        <RunCard label="A" run={view.a} highlight={winsA > winsB} />
        <RunCard label="B" run={view.b} highlight={winsB > winsA} />
      </div>

      <section>
        <h2 className="font-semibold mb-2">Per-field deltas (B − A)</h2>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b">
              <th className="text-left py-2">field</th>
              <th className="text-right">A</th>
              <th className="text-right">B</th>
              <th className="text-right">Δ</th>
              <th className="text-right">winner</th>
            </tr>
          </thead>
          <tbody>
            {view.perField.map((f) => (
              <tr key={f.field} className="border-b">
                <td className="py-2">{f.field}</td>
                <td className="text-right font-mono">{(f.a * 100).toFixed(1)}%</td>
                <td className="text-right font-mono">{(f.b * 100).toFixed(1)}%</td>
                <td
                  className={
                    "text-right font-mono " +
                    (f.delta > 0.005
                      ? "text-emerald-500"
                      : f.delta < -0.005
                        ? "text-rose-500"
                        : "")
                  }
                >
                  {f.delta >= 0 ? "+" : ""}
                  {(f.delta * 100).toFixed(1)} pp
                </td>
                <td className="text-right">
                  {f.winner === "tie" ? "tie" : f.winner.toUpperCase()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="grid md:grid-cols-2 gap-3">
        <CaseDeltaList
          title={`B beats A on (${bBetterCases.length})`}
          rows={bBetterCases.sort((x, y) => (y.delta ?? 0) - (x.delta ?? 0))}
          tone="b"
        />
        <CaseDeltaList
          title={`A beats B on (${aBetterCases.length})`}
          rows={aBetterCases.sort((x, y) => (x.delta ?? 0) - (y.delta ?? 0))}
          tone="a"
        />
      </section>
    </div>
  );
}

function RunCard({
  label,
  run,
  highlight,
}: {
  label: string;
  run: CompareView["a"];
  highlight: boolean;
}) {
  return (
    <div
      className={
        "border rounded p-3 " +
        (highlight ? "border-emerald-500" : "")
      }
    >
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold">{label}</span>
        <span className="font-medium">{run.strategy}</span>
        <span className="text-xs font-mono">{run.promptHash}</span>
      </div>
      <div className="text-sm text-muted-foreground">{run.model}</div>
      <div className="mt-2 grid grid-cols-2 text-sm">
        <div>F1 {pct(run.aggregateF1)}</div>
        <div>${run.totalCostUsd.toFixed(3)}</div>
        <div>schema-invalid {run.schemaFailureCount}</div>
        <div>halluc {run.hallucinationCount}</div>
      </div>
    </div>
  );
}

function CaseDeltaList({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: CompareView["perCase"];
  tone: "a" | "b";
}) {
  const color = tone === "b" ? "text-emerald-500" : "text-rose-500";
  return (
    <div>
      <h3 className="font-semibold mb-1">{title}</h3>
      <table className="w-full text-xs border-collapse">
        <tbody>
          {rows.slice(0, 12).map((r) => (
            <tr key={r.transcriptId} className="border-b">
              <td className="py-1">{r.transcriptId}</td>
              <td className="text-right font-mono">{pct(r.a)}</td>
              <td className="text-right font-mono">{pct(r.b)}</td>
              <td className={"text-right font-mono " + color}>
                {r.delta != null ? `${r.delta >= 0 ? "+" : ""}${(r.delta * 100).toFixed(1)} pp` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
