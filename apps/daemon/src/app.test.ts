import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Health } from "@tenzo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, VERSION } from "./app.ts";

const environmentId = "env_abcdefghij0123456789";
let webDir: string;

beforeEach(() => {
  webDir = mkdtempSync(join(tmpdir(), "tenzo-web-"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Tenzo</title>");
  mkdirSync(join(webDir, "_app", "immutable"), { recursive: true });
  writeFileSync(join(webDir, "_app", "immutable", "start.abc123.js"), "export {};");
  writeFileSync(join(webDir, "robots.txt"), "User-agent: *");
});
afterEach(() => {
  rmSync(webDir, { recursive: true, force: true });
});

const app = () => createApp({ environmentId, webDir });

/** What Node's server hands Hono for a request from this Mac (auth.ts reads the socket). */
const LOCAL = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

describe("GET /health", () => {
  it("returns the daemon version and environment id per the contract", async () => {
    const res = await app().request("/health");
    expect(res.status).toBe(200);
    const body = Health.parse(await res.json());
    expect(body).toEqual({ ok: true, version: VERSION, environmentId });
  });
});

describe("web app", () => {
  it("serves index.html at / without caching it", async () => {
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("<title>Tenzo</title>");
  });

  it("serves hashed build assets as immutable", async () => {
    const res = await app().request("/_app/immutable/start.abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("serves other static files", async () => {
    const res = await app().request("/robots.txt");
    expect(await res.text()).toBe("User-agent: *");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("falls back to index.html for client routes", async () => {
    const res = await app().request("/threads/some-thread");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Tenzo</title>");
  });

  it("404s a missing asset instead of answering with HTML, and doesn't let it be cached", async () => {
    const res = await app().request("/_app/immutable/gone.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("does not escape the web dir", async () => {
    const res = await app().request("/../../etc/passwd");
    expect(await res.text()).not.toContain("root:");
    const encoded = await app().request("/%2e%2e/%2e%2e/etc/passwd");
    expect(await encoded.text()).not.toContain("root:");
  });

  it("says how to fix it when the web app is not built", async () => {
    const res = await createApp({ environmentId, webDir: join(webDir, "missing") }).request("/");
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/pnpm build/);
  });
});

describe("who may call", () => {
  const post = (headers: Record<string, string>, body = '{"type":"snapshot"}') =>
    app().request(
      "/api/commands",
      { method: "POST", headers: { "content-type": "application/json", ...headers }, body },
      LOCAL,
    );

  it("refuses a foreign Host everywhere (DNS rebinding)", async () => {
    for (const path of ["/health", "/", "/api/commands"]) {
      const res = await app().request(path, { headers: { Host: "evil.example" } });
      expect(res.status, path).toBe(403);
    }
    const allowed = createApp({ environmentId, webDir, allowedHosts: ["mac.tailnet.ts.net"] });
    const res = await allowed.request("/health", { headers: { Host: "mac.tailnet.ts.net" } });
    expect(res.status).toBe(200);
  });

  it("refuses API calls from another site's page", async () => {
    expect((await post({ Origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ Origin: "null" })).status).toBe(403);
    expect((await post({ Origin: "http://localhost:3000" })).status).toBe(403);
    // Ours (or no Origin at all: the CLI) get through to the API.
    expect((await post({ Host: "127.0.0.1:4780", Origin: "http://127.0.0.1:4780" })).status).toBe(503);
    expect((await post({})).status).toBe(503);
    const withDev = createApp({ environmentId, webDir, devOrigins: ["http://localhost:5173"] });
    const res = await withDev.request(
      "/api/commands",
      {
        method: "POST",
        headers: { "content-type": "application/json", Origin: "http://localhost:5173" },
        body: '{"type":"snapshot"}',
      },
      LOCAL,
    );
    expect(res.status).toBe(503);
  });

  it("serves the API behind Tailscale Serve on :8443 to that page only", async () => {
    const ts = "andreas-mac-mini.tail6259b4.ts.net";
    const behind = createApp({ environmentId, webDir, allowedHosts: [ts] });
    const call = (origin: string) =>
      behind.request(
        "/api/commands",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Host: `${ts}:8443`,
            "X-Forwarded-Host": `${ts}:8443`,
            Origin: origin,
          },
          body: '{"type":"snapshot"}',
        },
        LOCAL,
      );
    // Its own page: through the Origin check, then refused for want of a paired device.
    expect((await call(`https://${ts}:8443`)).status).toBe(401);
    expect((await call(`https://${ts}:9443`)).status).toBe(403);
    expect((await call(`http://${ts}:8443`)).status).toBe(403);
  });

  it("takes commands as JSON only", async () => {
    const res = await post({ "content-type": "text/plain" });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ ok: false, error: "Send the command as application/json." });
    expect((await post({ "content-type": "application/jsonx" })).status).toBe(415);
    expect((await post({ "content-type": "application/json; charset=utf-8" })).status).toBe(503);
  });

  it("answers unknown API paths with JSON, not the web app", async () => {
    const res = await app().request("/api/nope", {}, LOCAL);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false });
  });
});
