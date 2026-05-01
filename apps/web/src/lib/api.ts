import type { CompareView, RunDetail, RunSummary, StartRunRequest } from "@test-evals/shared";

const BASE = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8787";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export interface ProviderInfo {
  provider: "anthropic" | "google" | "none";
  defaultModel: string | null;
  hasAnthropic: boolean;
  hasGoogle: boolean;
}

export const api = {
  listRuns: () => json<RunSummary[]>("/api/v1/runs"),
  getRun: (id: string) => json<RunDetail>(`/api/v1/runs/${id}`),
  compare: (a: string, b: string) => json<CompareView>(`/api/v1/runs/${a}/compare/${b}`),
  startRun: (body: StartRunRequest) =>
    json<{ id: string }>("/api/v1/runs", { method: "POST", body: JSON.stringify(body) }),
  resume: (id: string) =>
    json<{ id: string; status: string }>(`/api/v1/runs/${id}/resume`, { method: "POST" }),
  config: () => json<ProviderInfo>("/api/v1/config"),
};

export const sseUrl = (id: string) => `${BASE}/api/v1/runs/${id}/events`;
