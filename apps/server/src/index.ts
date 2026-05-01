import { auth } from "@test-evals/auth";
import { env } from "@test-evals/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { configRouter } from "./routes/config";
import { datasetRouter } from "./routes/dataset";
import { runsRouter } from "./routes/runs";

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.route("/api/v1/runs", runsRouter);
app.route("/api/v1/dataset", datasetRouter);
app.route("/api/v1/config", configRouter);

app.get("/", (c) => {
  return c.text("OK");
});

export default {
  port: 8787,
  fetch: app.fetch,
};
