"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { STRATEGIES, type Strategy } from "@test-evals/shared";

import { api, type ProviderInfo } from "@/lib/api";

export default function NewRunPage() {
  const router = useRouter();
  const [strategy, setStrategy] = useState<Strategy>("zero_shot");
  const [model, setModel] = useState("claude-haiku-4-5-20251001");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<ProviderInfo | null>(null);

  useEffect(() => {
    api.config().then((cfg) => {
      setInfo(cfg);
      // Default the model field to whatever provider is currently active.
      if (cfg.defaultModel) setModel(cfg.defaultModel);
    });
  }, []);

  return (
    <div className="container mx-auto max-w-md p-4">
      <h1 className="text-xl font-semibold mb-4">New Run</h1>

      <ProviderBanner info={info} />

      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const res = await api.startRun({
              strategy,
              model,
              dataset_filter: filter
                ? filter
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
                : undefined,
            });
            router.push(`/runs/${res.id}`);
          } catch (err) {
            setError(String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="grid gap-1">
          <span className="text-sm">strategy</span>
          <select
            className="border rounded p-2 bg-background"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as Strategy)}
          >
            {STRATEGIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-sm">model</span>
          <input
            className="border rounded p-2 bg-background"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-sm">filter (optional, comma-separated case ids)</span>
          <input
            className="border rounded p-2 bg-background"
            placeholder="case_001,case_002"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        {error ? <div className="text-red-500 text-sm">{error}</div> : null}
        <button
          disabled={busy || info?.provider === "none"}
          className="border rounded p-2 hover:bg-muted disabled:opacity-50"
        >
          {busy ? "starting…" : "Start run"}
        </button>
      </form>
    </div>
  );
}

function ProviderBanner({ info }: { info: ProviderInfo | null }) {
  if (!info) return null;
  if (info.provider === "anthropic") {
    return (
      <div className="border rounded p-2 mb-3 text-sm bg-emerald-500/10 border-emerald-500/40">
        Provider: <b>Anthropic</b> · default model{" "}
        <code className="font-mono">{info.defaultModel}</code> · prompt caching active
      </div>
    );
  }
  if (info.provider === "google") {
    return (
      <div className="border rounded p-2 mb-3 text-sm bg-amber-500/10 border-amber-500/40">
        Provider: <b>Gemini</b> (free tier) · default model{" "}
        <code className="font-mono">{info.defaultModel}</code>. Add{" "}
        <code>ANTHROPIC_API_KEY</code> to <code>apps/server/.env</code> to switch — no
        restart needed.
      </div>
    );
  }
  return (
    <div className="border rounded p-2 mb-3 text-sm bg-rose-500/10 border-rose-500/40">
      No LLM credential found. Set <code>ANTHROPIC_API_KEY</code> or{" "}
      <code>GOOGLE_API_KEY</code> in <code>apps/server/.env</code>.
    </div>
  );
}
