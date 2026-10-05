import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  attachmentUrl,
  LIVE_DOOR,
  liveBase,
  liveUrl,
  ServerFrame,
  type ThreadView,
} from "@tenzo/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { FakeAdapter } from "./agent/fake-agent.ts";
import { PAIR_ATTEMPTS } from "./app.ts";
import { addProject } from "./projects.ts";
import { type RunningDaemon, startDaemon } from "./server.ts";
import { REVOKED_CODE } from "./socket.ts";
import { openStore } from "./store.ts";
import { initRepo, pairDevice, removeTempDirs, tempDir } from "./testing.ts";

/**
 * Remote mode end to end (auth.ts): a daemon behind "Tailscale Serve" (requests with the tailnet
 * Host and Serve's forwarding headers, from loopback), its live listener, and a dev server.
 */

afterAll(removeTempDirs);

const TS = "my-mac.tail0000.ts.net";
const MAIN = `https://${TS}:8443`;
const LIVE = `https://${TS}:8444`;
/** What Tailscale Serve adds to every request it forwards. */
const SERVE = { "x-forwarded-for": "100.64.0.7", "x-forwarded-proto": "https" };

let home: string;
let daemon: RunningDaemon;
let thread: ThreadView;
let dev: { port: number; server: Server; seen: IncomingHttpHeaders[]; close: () => Promise<void> };

/** A dev server that echoes the cookies it got, and tries to set Tenzo's. */
async function devServer() {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": ["__Host-tenzo=planted; Path=/; Secure", "__Host-tenzo-live=planted; Path=/", "app=1; Path=/"],
    });
    res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
  });
  const wss = new WebSocketServer({
    server,
    // The handshake's answer tries to plant Tenzo's cookie too.
  });
  wss.on("headers", (headers) => {
    headers.push("Set-Cookie: __Host-tenzo=planted; Path=/; Secure", "Set-Cookie: app=2; Path=/");
  });
  wss.on("connection", (ws, req) => {
    seen.push(req.headers);
    ws.send(`cookie ${req.headers.cookie ?? "none"}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    server,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function start(): Promise<RunningDaemon> {
  const adapter = new FakeAdapter();
  adapter.onStart = (session) => {
    session.onPrompt = () => {
      session.expose(dev.port, "");
      session.complete();
    };
  };
  return startDaemon(
    {
      host: "127.0.0.1",
      port: 0,
      home,
      webDir: join(home, "web"),
      allowedHosts: [TS],
      devOrigins: [],
      liveOrigins: [LIVE],
    },
    { adapters: { claude: adapter } },
  );
}

beforeEach(async () => {
  home = join(tempDir("home"), ".tenzo");
  const store = openStore(home);
  await addProject(store, initRepo("app"));
  store.close();
  mkdirSync(join(home, "web"), { recursive: true });
  writeFileSync(join(home, "web", "index.html"), "<!doctype html><title>Tenzo</title>");
  dev = await devServer();
  daemon = await start();
  thread = await daemon.engine.createThread({ project: "app", prompt: "expose" });
  await expect.poll(() => daemon.engine.livePort(thread.id)).toBe(dev.port);
});
afterEach(async () => {
  await daemon.close();
  await dev.close();
});

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Any request, Host included (fetch won't set it), to the daemon or its live listener. */
function call(
  path: string,
  { port = daemon.port, method = "GET", headers = {}, body }: {
    port?: number;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** A request from the paired phone's page (or an unpaired one), through Serve. */
const remote = (extra: Record<string, string> = {}) => ({
  host: `${TS}:8443`,
  origin: MAIN,
  "sec-fetch-site": "same-origin",
  ...SERVE,
  ...extra,
});
const json = { "content-type": "application/json" };
const snapshot = { type: "snapshot" };

function command(headers: Record<string, string>, body: unknown = snapshot): Promise<Answer> {
  return call("/api/commands", { method: "POST", headers: { ...json, ...headers }, body });
}

/** Opens a socket; resolves with its first frames' types, or the refusal's status. */
function socket(
  headers: Record<string, string>,
  { port = daemon.port, path = "/ws" } = {},
): Promise<{ status: number; ws?: WebSocket; first?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once("message", (data) => resolve({ status: 101, ws, first: String(data) }));
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.on("error", reject);
  });
}

/** The snapshot frame a new socket gets after its hello. */
function snapshotOf(headers: Record<string, string>): Promise<Extract<ServerFrame, { type: "snapshot" }>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`, { headers });
    ws.on("message", (data) => {
      const frame = ServerFrame.parse(JSON.parse(String(data)));
      if (frame.type !== "snapshot") return;
      ws.close();
      resolve(frame);
    });
    ws.on("error", reject);
  });
}

describe("on the Mac itself", () => {
  it("needs no login, as before", async () => {
    expect((await command({ host: `127.0.0.1:${daemon.port}` })).status).toBe(200);
    const { status, ws } = await socket({ origin: `http://127.0.0.1:${daemon.port}` });
    expect(status).toBe(101);
    ws?.close();
    const session = await call("/api/session", { headers: { host: `localhost:${daemon.port}` } });
    expect(JSON.parse(session.body)).toEqual({ mode: "local", device: null });
  });
});

describe("from elsewhere, unpaired", () => {
  it("gets the web app and how to pair, and no data", async () => {
    expect((await call("/", { headers: remote() })).status).toBe(200);
    expect((await call("/pair", { headers: remote() })).status).toBe(200);
    expect((await call("/health", { headers: remote() })).status).toBe(200);
    const session = await call("/api/session", { headers: remote() });
    expect(JSON.parse(session.body)).toEqual({ mode: "remote", device: null });
    expect(session.headers["cache-control"]).toBe("no-store");

    const refused = await command(remote());
    expect(refused.status).toBe(401);
    expect(JSON.parse(refused.body).error).toMatch(/tenzo pair/);
    mkdirSync(join(home, "attachments", thread.id), { recursive: true });
    writeFileSync(join(home, "attachments", thread.id, "att_aaaaaaaaaaaaaaaaaaaa.png"), "png");
    const image = attachmentUrl(thread.id, { file: "att_aaaaaaaaaaaaaaaaaaaa.png" });
    expect((await call(image, { headers: remote() })).status).toBe(401);
    expect((await socket(remote())).status).toBe(401);
  });

  it("is remote even when it claims to be the Mac", async () => {
    // Host: localhost through Serve: the forwarding headers give it away.
    const spoofed = { host: `localhost:${daemon.port}`, ...SERVE };
    expect((await command(spoofed)).status).toBe(401);
    expect((await socket(spoofed)).status).toBe(401);
    // A tailnet Host with no forwarding headers at all is still remote.
    expect((await command({ host: TS })).status).toBe(401);
  });
});

describe("pairing", () => {
  it("trades a pairing link's code for a device cookie, once", async () => {
    const { code } = daemon.devices.pair("phone");
    const pair = (c: string) =>
      call("/api/pair", { method: "POST", headers: { ...json, ...remote() }, body: { code: c } });
    const first = await pair(`${MAIN}/pair#${code}`);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({ ok: true, device: { name: "phone" } });
    const [cookie] = first.headers["set-cookie"] ?? [];
    expect(cookie).toMatch(/^__Host-tenzo=[A-Za-z0-9_-]{43}; /);
    for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"]) {
      expect(cookie?.split("; "), attribute).toContain(attribute);
    }
    // The token never travels in the body, where page scripts could read it.
    expect(first.body).not.toContain(cookie?.split(";")[0]?.split("=")[1]);

    const deviceCookie = cookie?.split(";")[0] ?? "";
    expect((await command(remote({ cookie: deviceCookie }))).status).toBe(200);
    const session = await call("/api/session", { headers: remote({ cookie: deviceCookie }) });
    expect(JSON.parse(session.body)).toMatchObject({ mode: "remote", device: { name: "phone" } });

    const again = await pair(code);
    expect(again.status).toBe(400);
    expect(JSON.parse(again.body).error).toMatch(/expired or was already used/);
    expect((await pair("not-a-code")).status).toBe(400);
  });

  it("refuses a GET, a form post and a foreign page", async () => {
    const { code } = daemon.devices.pair();
    expect((await call(`/api/pair?code=${code}`, { headers: remote() })).status).toBe(404);
    expect(
      (await call("/api/pair", { method: "POST", headers: { ...remote(), "content-type": "text/plain" }, body: { code } }))
        .status,
    ).toBe(415);
    expect(
      (await call("/api/pair", { method: "POST", headers: { ...json, ...remote({ origin: "https://evil.example" }) }, body: { code } }))
        .status,
    ).toBe(403);
    // Still unused.
    expect(daemon.devices.exchange(code, "x")).not.toBeNull();
  });

  it("limits attempts", async () => {
    const attempt = () =>
      call("/api/pair", { method: "POST", headers: { ...json, ...remote() }, body: { code: "a".repeat(26) } });
    for (let i = 0; i < PAIR_ATTEMPTS.limit; i++) expect((await attempt()).status).toBe(400);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // Even a good code waits.
    const { code } = daemon.devices.pair();
    const good = await call("/api/pair", { method: "POST", headers: { ...json, ...remote() }, body: { code } });
    expect(good.status).toBe(429);
  });

  it("makes links on the Mac only", async () => {
    const local = await command({ host: `127.0.0.1:${daemon.port}` }, { type: "device.pair", name: "tablet" });
    expect(JSON.parse(local.body)).toMatchObject({ ok: true, result: { code: expect.any(String) } });
    const { cookie } = pairDevice(daemon.devices);
    const fromPhone = await command(remote({ cookie }), { type: "device.pair" });
    expect(fromPhone.status).toBe(400);
    expect(JSON.parse(fromPhone.body).error).toMatch(/on the Mac itself/);
  });

  it("survives a daemon restart", async () => {
    const { cookie } = pairDevice(daemon.devices);
    await daemon.close();
    daemon = await start();
    expect((await command(remote({ cookie }))).status).toBe(200);
  });
});

describe("a paired device", () => {
  it("is taken by its device cookie from Tenzo's own pages only", async () => {
    const { id, cookie } = pairDevice(daemon.devices);
    expect((await command(remote({ cookie }))).status).toBe(200);
    // From a live page (same site, other origin): its Origin is refused first, and even without
    // an Origin the cookie isn't taken from a same-site request.
    expect((await command(remote({ cookie, origin: LIVE }))).status).toBe(403);
    const { origin: _, ...noOrigin } = remote({ cookie, "sec-fetch-site": "same-site" });
    expect((await call(attachmentUrl(thread.id, { file: "att_aaaaaaaaaaaaaaaaaaaa.png" }), { headers: noOrigin })).status).toBe(401);
    // The live origin's credential is no good here.
    const live = `__Host-tenzo-live=${daemon.devices.livePass(id)}`;
    expect((await command(remote({ cookie: live }))).status).toBe(401);
    expect((await socket(remote({ cookie: live }))).status).toBe(401);
  });

  it("lists, renames and revokes devices, and knows which one it is", async () => {
    const phone = pairDevice(daemon.devices, "iPhone");
    const other = pairDevice(daemon.devices, "iPad");
    const listed = JSON.parse((await command(remote({ cookie: phone.cookie }), { type: "device.list" })).body);
    expect(listed.result.current).toBe(phone.id);
    expect(listed.result.devices.map((d: { name: string }) => d.name).sort()).toEqual(["iPad", "iPhone"]);
    await command(remote({ cookie: phone.cookie }), { type: "device.rename", deviceId: phone.id, name: "Work phone" });
    expect(daemon.devices.find(phone.id)?.name).toBe("Work phone");
    await command(remote({ cookie: phone.cookie }), { type: "device.revoke", deviceId: other.id });
    expect((await command(remote({ cookie: other.cookie }))).status).toBe(401);
  });

  it("is disconnected the moment it is revoked", async () => {
    const { id, cookie } = pairDevice(daemon.devices);
    const { status, ws } = await socket(remote({ cookie }));
    expect(status).toBe(101);
    const closed = new Promise<number>((resolve) => ws?.once("close", (code) => resolve(code)));
    const revoked = await command({ host: `127.0.0.1:${daemon.port}` }, { type: "device.revoke", deviceId: id });
    expect(revoked.status).toBe(200);
    expect(await closed).toBe(REVOKED_CODE);
    expect((await socket(remote({ cookie }))).status).toBe(401);
    expect((await command(remote({ cookie }))).status).toBe(401);
  });

  it("gets a pass to the live origin in its snapshot; the Mac needs none", async () => {
    const { cookie } = pairDevice(daemon.devices);
    const phone = await snapshotOf(remote({ cookie }));
    expect(phone.snapshot.live?.grant).toMatch(/^dev_[a-z0-9]{20}\.\d+\./);
    expect(phone.snapshot.live?.origins).toEqual([LIVE]);
    expect((await snapshotOf({})).snapshot.live?.grant).toBeNull();
  });
});

describe("the live origin", () => {
  const page = () => `${liveBase(thread.id)}x`;
  const fromLive = (extra: Record<string, string> = {}) => ({
    host: `${TS}:8444`,
    ...SERVE,
    ...extra,
  });

  it("refuses Tenzo's own device cookie", async () => {
    const { cookie } = pairDevice(daemon.devices);
    expect((await call(page(), { port: daemon.livePort, headers: fromLive({ cookie }) })).status).toBe(401);
    expect((await socket(fromLive({ cookie }), { port: daemon.livePort, path: liveBase(thread.id) })).status).toBe(401);
    expect(dev.seen).toHaveLength(0);
  });

  it("trades an Open live grant for its own cookie at its door, then serves the app", async () => {
    const { id, cookie } = pairDevice(daemon.devices);
    const grant = daemon.devices.liveGrant(id);
    const link = new URL(liveUrl(LIVE, thread.id, { path: "x?y=1" }, grant));
    expect(link.pathname).toBe(LIVE_DOOR);
    const door = await call(`${link.pathname}${link.search}`, { port: daemon.livePort, headers: fromLive() });
    expect(door.status).toBe(303);
    expect(door.headers.location).toBe(`${liveBase(thread.id)}x?y=1`);
    const [set] = door.headers["set-cookie"] ?? [];
    expect(set).toMatch(/^__Host-tenzo-live=dev_/);
    for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"]) {
      expect(set?.split("; "), attribute).toContain(attribute);
    }
    const live = set?.split(";")[0] ?? "";

    // Both Tenzo cookies arrive (cookies ignore ports); neither reaches the dev server.
    const res = await call(page(), {
      port: daemon.livePort,
      headers: fromLive({ cookie: `app=1; ${cookie}; ${live}` }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ cookie: "app=1" });
    // And the dev server can't set them.
    expect(res.headers["set-cookie"]).toEqual(["app=1; Path=/"]);
  });

  it("strips Tenzo's cookies from a live WebSocket, both ways, and closes it on revoke", async () => {
    const { id, cookie } = pairDevice(daemon.devices);
    const live = `__Host-tenzo-live=${daemon.devices.livePass(id)}`;
    let handshake: IncomingHttpHeaders = {};
    const opened = await new Promise<{ ws: WebSocket; first: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.livePort}${liveBase(thread.id)}`, {
        headers: fromLive({ cookie: `${cookie}; app=1; ${live}` }),
      });
      ws.on("upgrade", (res) => {
        handshake = res.headers;
      });
      ws.once("message", (data) => resolve({ ws, first: String(data) }));
      ws.on("error", reject);
    });
    expect(opened.first).toBe("cookie app=1");
    expect(handshake["set-cookie"]).toEqual(["app=2; Path=/"]);
    const closed = new Promise<void>((resolve) => opened.ws.once("close", () => resolve()));
    daemon.devices.revoke(id);
    await closed;
  });

  it("turns away a bad door or an expired grant", async () => {
    const { id } = pairDevice(daemon.devices);
    const grant = daemon.devices.liveGrant(id);
    const door = (to: string, g = grant) =>
      call(`${LIVE_DOOR}?grant=${encodeURIComponent(g)}&to=${encodeURIComponent(to)}`, {
        port: daemon.livePort,
        headers: fromLive(),
      });
    for (const to of ["https://evil.example/", "//evil.example/", "/api/commands", `/live/${thread.id}/\\evil`]) {
      expect((await door(to)).status, to).toBe(400);
    }
    expect((await door(page(), "dev_aaaaaaaaaaaaaaaaaaaa.99999999999999.forged")).status).toBe(401);
    daemon.devices.revoke(id);
    expect((await door(page())).status).toBe(401);
  });

  it("needs nothing on the Mac itself", async () => {
    expect((await call(page(), { port: daemon.livePort })).status).toBe(200);
  });
});
