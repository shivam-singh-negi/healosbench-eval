import { Hono } from "hono";

import { getProviderInfo } from "../lib/anthropic-client";

export const configRouter = new Hono();

/**
 * Tells the web app which provider is currently configured, so the new-run
 * form can default the model field correctly. Re-evaluated on every request,
 * so swapping the key in `.env` is reflected without a server restart.
 */
configRouter.get("/", (c) => {
  return c.json(getProviderInfo());
});
