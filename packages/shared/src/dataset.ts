import { existsSync as existsSyncFn, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DatasetCase } from "./dto";
import { ExtractionSchema } from "./schema";

export type { DatasetCase };

/**
 * Resolve the data/ directory relative to a base path. We accept the base
 * so the loader works the same from the server, the CLI, and tests.
 */
export function resolveDataDir(baseDir: string): string {
  return join(baseDir, "data");
}

/**
 * Loads transcripts + gold. Accepts either the repo root (then we append
 * `data/`) or the `data/` directory directly — convenient for callers.
 */
export function loadDataset(repoRootOrDataDir: string, filter?: string[]): DatasetCase[] {
  const transcriptsDir = join(repoRootOrDataDir, "transcripts");
  const dataDir = existsSyncFn(transcriptsDir)
    ? repoRootOrDataDir
    : join(repoRootOrDataDir, "data");
  const realTranscripts = join(dataDir, "transcripts");
  const goldDir = join(dataDir, "gold");
  const filterSet = filter ? new Set(filter) : null;

  const files = readdirSync(realTranscripts)
    .filter((f) => f.endsWith(".txt"))
    .sort();

  const cases: DatasetCase[] = [];
  for (const f of files) {
    const transcriptId = f.replace(/\.txt$/, "");
    if (filterSet && !filterSet.has(transcriptId)) continue;

    const transcript = readFileSync(join(realTranscripts, f), "utf8");
    const goldPath = join(goldDir, `${transcriptId}.json`);
    const goldRaw = JSON.parse(readFileSync(goldPath, "utf8"));
    const gold = ExtractionSchema.parse(goldRaw);
    cases.push({ transcriptId, transcript, gold });
  }
  return cases;
}
