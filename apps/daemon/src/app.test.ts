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

  it("404s a missing asset instead of answering with HTML", async () => {
    expect((await app().request("/_app/immutable/gone.js")).status).toBe(404);
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
