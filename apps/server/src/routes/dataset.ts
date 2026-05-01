import { loadDataset } from "@test-evals/shared/dataset";
import { Hono } from "hono";

import { findRepoRoot } from "../lib/repo-root";

export const datasetRouter = new Hono();

datasetRouter.get("/", (c) => {
  const ds = loadDataset(findRepoRoot());
  return c.json(
    ds.map((d) => ({ transcriptId: d.transcriptId })),
  );
});

datasetRouter.get("/:transcriptId", (c) => {
  const tid = c.req.param("transcriptId");
  const ds = loadDataset(findRepoRoot(), [tid]);
  if (ds.length === 0) return c.json({ error: "not_found" }, 404);
  return c.json(ds[0]);
});
