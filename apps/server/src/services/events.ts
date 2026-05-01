import type { RunEvent } from "@test-evals/shared";

/**
 * Tiny in-memory pub/sub for SSE. One topic per run id.
 *
 * We keep the last N events so a late subscriber can still see progress
 * (helpful for the dashboard refreshing mid-run). When a run completes,
 * we emit `run_completed` then close.
 */
export class RunEventBus {
  private subs = new Map<string, Set<(e: RunEvent) => void>>();
  private buffer = new Map<string, RunEvent[]>();
  private readonly bufferLimit = 200;

  publish(runId: string, event: RunEvent): void {
    const buf = this.buffer.get(runId) ?? [];
    buf.push(event);
    if (buf.length > this.bufferLimit) buf.shift();
    this.buffer.set(runId, buf);
    const subs = this.subs.get(runId);
    if (subs) for (const s of subs) s(event);
  }

  subscribe(runId: string, fn: (e: RunEvent) => void): () => void {
    let set = this.subs.get(runId);
    if (!set) {
      set = new Set();
      this.subs.set(runId, set);
    }
    set.add(fn);
    // Replay buffered events to the new subscriber.
    const buf = this.buffer.get(runId) ?? [];
    for (const e of buf) fn(e);
    return () => {
      set?.delete(fn);
    };
  }
}

export const runEventBus = new RunEventBus();
