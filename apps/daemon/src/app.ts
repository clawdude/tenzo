import { Hono } from "hono";

export const VERSION = "0.0.0";

/** The daemon's HTTP surface. Health and the WebSocket arrive in #2. */
export function createApp(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.text(`tenzo daemon ${VERSION}\n`));
  return app;
}
