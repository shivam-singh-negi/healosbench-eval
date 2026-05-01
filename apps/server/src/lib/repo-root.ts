import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/**
 * Walk up from this file until we find the workspace root (the directory
 * containing both `data/` and `package.json` with our workspaces config).
 * Cached after the first hit.
 */
export function findRepoRoot(): string {
  if (cached) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, "data/schema.json")) && existsSync(resolve(dir, "package.json"))) {
      cached = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate repo root (looking for data/schema.json + package.json)");
}
