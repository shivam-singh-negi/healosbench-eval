import { existsSync, readFileSync } from "node:fs";

import { AnthropicClient, GoogleClient, type LlmClient } from "@test-evals/llm";

import { findRepoRoot } from "./repo-root";

/**
 * LLM client factory.
 *
 * The factory re-reads `apps/server/.env` on every call so that adding/removing
 * a credential takes effect immediately — you don't have to restart the server
 * after editing the file. Cost is one tiny file read per LLM request, which
 * is negligible compared to the network call that follows.
 *
 * Provider selection (in order):
 *   1. ANTHROPIC_API_KEY  → AnthropicClient (the spec-aligned default)
 *   2. GOOGLE_API_KEY     → GoogleClient   (Gemini fallback)
 *   3. throw with a clear message
 */
export function getLlmClient(): LlmClient {
  const ak = readEnv("ANTHROPIC_API_KEY");
  if (ak) return new AnthropicClient(ak);
  const gk = readEnv("GOOGLE_API_KEY");
  if (gk) return new GoogleClient(gk);
  throw new Error(
    "No LLM credential found. Add ANTHROPIC_API_KEY (preferred) or GOOGLE_API_KEY to apps/server/.env.",
  );
}

/** Back-compat alias — older imports use this name. */
export const getAnthropicClient = getLlmClient;

/**
 * Returns provider + default model for the currently-configured key, used by
 * the dashboard's `/api/v1/config` endpoint and the "new run" form.
 */
export function getProviderInfo(): {
  provider: "anthropic" | "google" | "none";
  defaultModel: string | null;
  hasAnthropic: boolean;
  hasGoogle: boolean;
} {
  const ak = readEnv("ANTHROPIC_API_KEY");
  const gk = readEnv("GOOGLE_API_KEY");
  if (ak) return { provider: "anthropic", defaultModel: "claude-haiku-4-5-20251001", hasAnthropic: true, hasGoogle: !!gk };
  if (gk) return { provider: "google", defaultModel: "gemini-2.0-flash", hasAnthropic: false, hasGoogle: true };
  return { provider: "none", defaultModel: null, hasAnthropic: false, hasGoogle: false };
}

/** Read a single env var, preferring `apps/server/.env` over process.env. */
function readEnv(key: string): string | undefined {
  // Re-read the .env file each call so live edits take effect without a
  // restart. We treat `KEY=` (empty) and `KEY="..."` and `KEY='...'` correctly.
  try {
    const path = `${findRepoRoot()}/apps/server/.env`;
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        if (line.slice(0, eq) !== key) continue;
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return value || undefined;
      }
    }
  } catch {
    // fall through to process.env
  }
  const env = process.env[key];
  return env && env.length > 0 ? env : undefined;
}

/** For tests. */
export function setAnthropicClient(_client: LlmClient): void {
  // Intentional no-op — clients are created per call now. Keeping the symbol
  // so existing imports don't break.
}
