"use client";

import { useEffect, useState } from "react";

import type { CaseDTO, DatasetCase, Extraction } from "@test-evals/shared";

import FieldDiff from "./field-diff";

const BASE = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8787";

/**
 * Highlight transcript spans that are referenced by predicted free-text
 * fields. Cheap and visual: for each candidate value, normalize, find
 * occurrences in the transcript, wrap them in a <mark>.
 */
function highlightTranscript(transcript: string, prediction: Extraction | null): React.ReactNode {
  if (!prediction) return transcript;
  const claims = new Set<string>();
  claims.add(prediction.chief_complaint.toLowerCase());
  for (const m of prediction.medications) claims.add(m.name.toLowerCase());
  for (const d of prediction.diagnoses) claims.add(d.description.toLowerCase());
  for (const p of prediction.plan) claims.add(p.toLowerCase());
  if (prediction.follow_up.reason) claims.add(prediction.follow_up.reason.toLowerCase());

  // Find ranges to highlight (case-insensitive substring); merge overlapping.
  const ranges: [number, number][] = [];
  const lower = transcript.toLowerCase();
  for (const c of claims) {
    if (!c) continue;
    let from = 0;
    while (from < lower.length) {
      const i = lower.indexOf(c, from);
      if (i < 0) break;
      ranges.push([i, i + c.length]);
      from = i + c.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    if (merged.length === 0 || r[0] > merged[merged.length - 1]![1]) {
      merged.push(r);
    } else {
      merged[merged.length - 1]![1] = Math.max(merged[merged.length - 1]![1], r[1]);
    }
  }
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < merged.length; i++) {
    const [s, e] = merged[i]!;
    if (cursor < s) parts.push(transcript.slice(cursor, s));
    parts.push(
      <mark key={i} className="bg-yellow-200/60 dark:bg-yellow-900/60">
        {transcript.slice(s, e)}
      </mark>,
    );
    cursor = e;
  }
  if (cursor < transcript.length) parts.push(transcript.slice(cursor));
  return parts;
}

export default function CaseInspector({
  kase,
  onClose,
}: {
  kase: CaseDTO;
  onClose: () => void;
}) {
  const [ds, setDs] = useState<DatasetCase | null>(null);

  useEffect(() => {
    fetch(`${BASE}/api/v1/dataset/${kase.transcriptId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then(setDs)
      .catch(() => setDs(null));
  }, [kase.transcriptId]);

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-stretch justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-background border rounded-lg flex-1 max-w-6xl overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-background border-b p-3 flex items-center gap-3">
          <h2 className="font-semibold">{kase.transcriptId}</h2>
          <span className="text-sm">overall: {pct(kase.scores?.overall ?? null)}</span>
          {kase.schemaInvalid ? <span className="text-red-500 text-sm">schema-invalid</span> : null}
          <button className="ml-auto text-sm underline" onClick={onClose}>
            close
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3">
          <section>
            <h3 className="font-semibold mb-1">Transcript</h3>
            <pre className="text-xs whitespace-pre-wrap border rounded p-2 max-h-96 overflow-auto">
              {ds ? highlightTranscript(ds.transcript, kase.prediction as Extraction) : "loading…"}
            </pre>
            {kase.hallucinations.length > 0 ? (
              <div className="mt-2 text-xs">
                <div className="font-semibold text-red-500 mb-1">
                  Possible hallucinations ({kase.hallucinations.length})
                </div>
                <ul className="list-disc ml-5">
                  {kase.hallucinations.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          <section>
            <h3 className="font-semibold mb-1">Field-level diff</h3>
            <FieldDiff
              gold={ds?.gold ?? null}
              pred={kase.prediction as Extraction | null}
            />
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                raw JSON (gold ↔ predicted)
              </summary>
              <DiffPanel gold={ds?.gold ?? null} pred={kase.prediction as Extraction | null} />
            </details>
          </section>
        </div>

        <section className="border-t p-3">
          <h3 className="font-semibold mb-1">Attempts ({kase.attempts.length})</h3>
          <div className="grid gap-2 text-xs">
            {kase.attempts.map((a) => (
              <details key={a.id} className="border rounded p-2">
                <summary className="cursor-pointer">
                  attempt {a.attempt} · cost ${a.costUsd.toFixed(5)} · in
                  {a.inputTokens}t / out {a.outputTokens}t · cache_read{" "}
                  {a.cacheReadInputTokens}t · cache_write {a.cacheCreationInputTokens}t · {a.durationMs}ms{" "}
                  {a.validationErrors ? <span className="text-red-500">· invalid</span> : null}
                </summary>
                {a.validationErrors ? (
                  <div className="text-red-500 mt-2">
                    <div className="font-semibold">validation errors</div>
                    <ul className="list-disc ml-5">
                      {a.validationErrors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <details className="mt-2">
                  <summary className="cursor-pointer">request</summary>
                  <pre className="overflow-auto whitespace-pre-wrap mt-1">
                    {JSON.stringify(a.request, null, 2)}
                  </pre>
                </details>
                <details className="mt-2">
                  <summary className="cursor-pointer">response</summary>
                  <pre className="overflow-auto whitespace-pre-wrap mt-1">
                    {JSON.stringify(a.response, null, 2)}
                  </pre>
                </details>
              </details>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function pct(n: number | null): string {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function DiffPanel({ gold, pred }: { gold: Extraction | null; pred: Extraction | null }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <div>
        <div className="font-semibold text-muted-foreground">gold</div>
        <pre className="border rounded p-2 max-h-96 overflow-auto whitespace-pre-wrap">
          {gold ? JSON.stringify(gold, null, 2) : "—"}
        </pre>
      </div>
      <div>
        <div className="font-semibold text-muted-foreground">predicted</div>
        <pre className="border rounded p-2 max-h-96 overflow-auto whitespace-pre-wrap">
          {pred ? JSON.stringify(pred, null, 2) : "—"}
        </pre>
      </div>
    </div>
  );
}
