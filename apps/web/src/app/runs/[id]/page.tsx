"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";

import type { CaseDTO, RunDetail } from "@test-evals/shared";

import { api } from "@/lib/api";

import CaseInspector from "./case-inspector";

function pct(n: number | null | undefined): string {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}

export default function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<CaseDTO | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .getRun(id)
        .then((r) => alive && setData(r))
        .catch((e) => alive && setError(String(e)));
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  if (error) return <div className="p-4 text-red-500">{error}</div>;
  if (!data) return <div className="p-4">loading…</div>;

  const a = data.perFieldAggregate;

  return (
    <div className="container mx-auto max-w-6xl p-4">
      <div className="flex items-baseline gap-3 mb-4">
        <h1 className="text-xl font-semibold">{data.strategy}</h1>
        <span className="font-mono text-xs">{data.promptHash}</span>
        <span className="text-sm text-muted-foreground">{data.model}</span>
        <span className="ml-auto text-sm">{data.status}</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-7 gap-2 mb-4 text-center">
        <Stat label="overall" value={pct(a.overall)} />
        <Stat label="chief_complaint" value={pct(a.chief_complaint)} />
        <Stat label="vitals" value={pct(a.vitals)} />
        <Stat label="meds_f1" value={pct(a.medications_f1)} />
        <Stat label="dx_f1" value={pct(a.diagnoses_f1)} />
        <Stat label="plan_f1" value={pct(a.plan_f1)} />
        <Stat label="follow_up" value={pct(a.follow_up)} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-6 text-sm">
        <Stat label="cost" value={`$${data.totalCostUsd.toFixed(4)}`} />
        <Stat label="cache_read tok" value={data.totalCacheReadInputTokens.toLocaleString()} />
        <Stat label="schema_invalid" value={String(data.schemaFailureCount)} />
        <Stat label="hallucinations" value={String(data.hallucinationCount)} />
      </div>

      <h2 className="font-semibold mb-2">Cases</h2>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b">
            <th className="text-left py-2">case</th>
            <th className="text-left">status</th>
            <th className="text-right">overall</th>
            <th className="text-right">cc</th>
            <th className="text-right">vitals</th>
            <th className="text-right">meds</th>
            <th className="text-right">dx</th>
            <th className="text-right">plan</th>
            <th className="text-right">f/u</th>
            <th className="text-right">halluc.</th>
          </tr>
        </thead>
        <tbody>
          {data.cases
            .slice()
            .sort((x, y) => x.transcriptId.localeCompare(y.transcriptId))
            .map((c) => (
              <tr
                key={c.id}
                className="border-b cursor-pointer hover:bg-muted/40"
                onClick={() => setOpen(c)}
              >
                <td className="py-2">{c.transcriptId}</td>
                <td>
                  {c.status}
                  {c.schemaInvalid ? <span className="text-red-500 ml-1">·schema</span> : null}
                </td>
                <td className="text-right">{pct(c.scores?.overall ?? null)}</td>
                <td className="text-right">{pct(c.scores?.chief_complaint ?? null)}</td>
                <td className="text-right">{pct(c.scores?.vitals ?? null)}</td>
                <td className="text-right">{pct(c.scores?.medications.f1 ?? null)}</td>
                <td className="text-right">{pct(c.scores?.diagnoses.f1 ?? null)}</td>
                <td className="text-right">{pct(c.scores?.plan.f1 ?? null)}</td>
                <td className="text-right">{pct(c.scores?.follow_up ?? null)}</td>
                <td className="text-right">{c.hallucinations.length}</td>
              </tr>
            ))}
        </tbody>
      </table>

      <div className="mt-6 text-sm">
        <Link className="underline" href="/runs">
          ← back to runs
        </Link>
      </div>

      {open ? <CaseInspector kase={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border rounded p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-mono">{value}</div>
    </div>
  );
}
