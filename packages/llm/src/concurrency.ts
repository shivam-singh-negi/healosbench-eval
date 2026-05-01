/**
 * Bounded-concurrency runner with adaptive backoff for 429s.
 *
 * - At most `concurrency` tasks in flight.
 * - On 429 (or `error.status === 429`), all in-flight callers cooperate
 *   on a shared "cooldown until" timestamp, so we don't keep hammering.
 * - Backoff: 1s, then 2s, 4s, 8s capped at 30s; reset on success.
 *
 * Why hand-rolled: the spec explicitly requires we *don't* naïve-Promise.all
 * and that we document our 429 strategy. Keeping it small and observable is
 * the point.
 */
export interface SemaphoreOptions {
  concurrency: number;
  /** Override sleep (test seam). */
  sleep?: (ms: number) => Promise<void>;
  /** Override now() for tests. */
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RateLimitedSemaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  private cooldownUntil = 0;
  private consecutive429s = 0;
  private readonly concurrency: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(opts: SemaphoreOptions) {
    this.concurrency = opts.concurrency;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => Date.now());
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      // Honour any active cooldown before each attempt.
      const wait = this.cooldownUntil - this.now();
      if (wait > 0) await this.sleep(wait);

      while (true) {
        try {
          const out = await fn();
          this.consecutive429s = 0;
          return out;
        } catch (err) {
          if (!isRateLimitError(err)) throw err;
          this.consecutive429s++;
          // Honour an explicit retry-after hint from Anthropic/Gemini (Gemini
          // returns it as a string like "48s" embedded in the response body).
          const hinted = retryAfterFromError(err);
          // Otherwise: 1s, 2s, 4s, 8s, 16s, 32s, 60s, capped at 90s.
          const backoff =
            hinted ?? Math.min(1000 * 2 ** (this.consecutive429s - 1), 90_000);
          this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + backoff);
          await this.sleep(backoff);
          if (this.consecutive429s > 10) throw err;
        }
      }
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; statusCode?: number; message?: string };
  // Retry on 429 (rate-limited) and 503 (provider overloaded).
  if (e.status === 429 || e.statusCode === 429) return true;
  if (e.status === 503 || e.statusCode === 503) return true;
  // Some clients (e.g. our GoogleClient) wrap the status into Error.message.
  if (typeof e.message === "string" && (e.message.includes("429") || e.message.includes("503"))) {
    return true;
  }
  return false;
}

/**
 * Pull a retry-after hint out of a 429. Gemini emits it as `retryDelay: "48s"`
 * inside the JSON body; we already serialised that into Error.message.
 * Returns the hint in milliseconds, or undefined if we can't parse one.
 */
function retryAfterFromError(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const msg = (err as { message?: string }).message;
  if (typeof msg !== "string") return undefined;
  const m = msg.match(/"retryDelay":\s*"(\d+)s"/);
  if (m) return Math.min(Number(m[1]) * 1000 + 500, 120_000);
  return undefined;
}
