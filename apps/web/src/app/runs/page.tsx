"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { RunSummary } from "@test-evals/shared";

import { api } from "@/lib/api";

function pct(n: number | null | undefined): string {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}

export default function RunsPage() {
  const [rows, setRows] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      api
        .listRuns()
        .then((r) => alive && setRows(r))
        .catch((e) => alive && setError(String(e)));
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (error) return <div className="p-4 text-red-500">{error}</div>;
  if (!rows) return <div className="p-4">loading…</div>;
  if (rows.length === 0)
    return (
      <div className="p-4">
        <p>no runs yet — create one in <Link className="underline" href="/runs/new">/runs/new</Link>.</p>
      </div>
    );

  return (
    <div className="container mx-auto max-w-6xl p-4">
      <h1 className="text-xl font-semibold mb-4">Runs</h1>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b">
            <th className="text-left py-2">strategy</th>
            <th className="text-left">model</th>
            <th className="text-left">prompt</th>
            <th className="text-left">status</th>
            <th className="text-right">cases</th>
            <th className="text-right">F1</th>
            <th className="text-right">cost</th>
            <th className="text-right">wall</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b hover:bg-muted/40">
              <td className="py-2">{r.strategy}</td>
              <td>{r.model}</td>
              <td className="font-mono text-xs">{r.promptHash}</td>
              <td>
                <span className={r.status === "completed" ? "" : "text-amber-500"}>
                  {r.status}
                </span>
                {r.completedCases !== r.totalCases ? (
                  <span className="text-xs ml-1 text-muted-foreground">
                    {r.completedCases}/{r.totalCases}
                  </span>
                ) : null}
              </td>
              <td className="text-right">
                {r.completedCases}/{r.totalCases}
                {r.failedCases ? <span className="text-red-500"> +{r.failedCases}f</span> : null}
              </td>
              <td className="text-right">{pct(r.aggregateF1)}</td>
              <td className="text-right">${r.totalCostUsd.toFixed(3)}</td>
              <td className="text-right">{(r.totalDurationMs / 1000).toFixed(1)}s</td>
              <td className="text-right">
                <Link className="underline" href={`/runs/${r.id}`}>
                  view
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
