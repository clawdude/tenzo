import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";

const config = readConfig(process.env);
serve({ fetch: createApp().fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`tenzo daemon listening on http://${config.host}:${info.port}`);
});
