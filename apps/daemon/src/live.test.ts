import { mkdirSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { attachmentUrl, liveBase, type ThreadView } from "@tenzo/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { FakeAdapter } from "./agent/fake-agent.ts";
import { checkPort, livePath, outsideBase } from "./live.ts";
import { addProject } from "./projects.ts";
import { type RunningDaemon, startDaemon } from "./server.ts";
import { openStore } from "./store.ts";
import { initRepo, removeTempDirs, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

const TS = "my-mac.tail0000.ts.net";
let home: string;
let daemon: RunningDaemon;
let upstream: { port: number; server: Server; seen: IncomingMessage[]; close: () => Promise<void> };
let thread: ThreadView;
let other: ThreadView;

/** The dev server a thread exposed: echoes what it got as JSON, and WebSocket messages back. */
async function devServer(host = "127.0.0.1") {
  const seen: IncomingMessage[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push(req);
    if (req.url?.endsWith("/away")) {
      res.writeHead(302, { location: `http://localhost:${port}${liveBase(thread.id)}here` });
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "service-worker-allowed": "/",
        "clear-site-data": '"storage"',
        "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
      });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          origin: req.headers.origin ?? null,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    ws.send(`hello ${req.url} from ${req.headers.host} for ${req.headers.origin ?? "none"}`);
    ws.on("message", (data) => ws.send(`echo ${String(data)}`));
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
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

beforeEach(async () => {
  home = join(tempDir("home"), ".tenzo");
  const store = openStore(home);
  await addProject(store, initRepo("app"));
  store.close();
  upstream = await devServer();
  const adapter = new FakeAdapter();
  adapter.onStart = (session) => {
    session.onPrompt = (prompt) => {
      const [word, port] = prompt.split(" ");
      if (word === "expose") session.expose(port ? Number(port) : upstream.port, "page");
      session.complete();
    };
  };
  daemon = await startDaemon(
    {
      host: "127.0.0.1",
      port: 0,
      home,
      webDir: join(home, "web"),
      allowedHosts: [TS],
      devOrigins: [],
    },
    { adapters: { claude: adapter } },
  );
  thread = await daemon.engine.createThread({ project: "app", prompt: "expose" });
  other = await daemon.engine.createThread({ project: "app", prompt: "nothing" });
  await expect.poll(() => daemon.engine.livePort(thread.id)).toBe(upstream.port);
});
afterEach(async () => {
  await daemon.close();
  await upstream.close();
});

const url = (path: string) => `http://127.0.0.1:${daemon.port}${path}`;

/** A GET with any headers, Host included (fetch won't set Host). Resolves with the status. */
function get(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: daemon.port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("live: HTTP", () => {
  it("forwards the thread's base to its port, path, method and body unchanged", async () => {
    const res = await fetch(url(`${liveBase(thread.id)}src/main.js?v=1`), {
      method: "POST",
      headers: { "content-type": "text/plain", origin: `http://127.0.0.1:${daemon.port}` },
      body: "hi",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      method: "POST",
      url: `${liveBase(thread.id)}src/main.js?v=1`,
      // The dev server sees its own address: its DNS-rebinding checks pass.
      host: `localhost:${upstream.port}`,
      origin: `http://localhost:${upstream.port}`,
      body: "hi",
    });
    // Its own cache headers, not the daemon's; nothing that reaches beyond its path.
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("service-worker-allowed")).toBeNull();
    expect(res.headers.get("clear-site-data")).toBeNull();
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("keeps redirects on the daemon's origin", async () => {
    const res = await fetch(url(`${liveBase(thread.id)}away`), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${liveBase(thread.id)}here`);
  });

  it("adds the slash to a bare thread base", async () => {
    const res = await fetch(url(`/live/${thread.id}`), { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(liveBase(thread.id));
  });

  it("works through Tailscale Serve's host and origin", async () => {
    expect(await get(`${liveBase(thread.id)}x`, { host: `${TS}:8443`, origin: `https://${TS}:8443` })).toBe(200);
  });

  it("refuses a foreign host or origin, like every other route", async () => {
    const path = `${liveBase(thread.id)}x`;
    expect(await get(path, { host: "evil.example" })).toBe(403);
    expect(await get(path, { origin: "https://evil.example" })).toBe(403);
    expect(await get(path, { origin: "http://localhost:3000" })).toBe(403);
    expect(await get(path, { host: `${TS}:8443`, origin: `http://${TS}:8443` })).toBe(403);
    expect(upstream.seen).toHaveLength(0);
  });

  it("refuses a thread without a live app, an unknown thread, and anything that isn't a thread", async () => {
    for (const path of [
      `${liveBase(other.id)}x`,
      "/live/thr_nopenopenopenopenope/x",
      "/live/..%2f..%2fapi/commands",
      "/live/",
    ]) {
      expect((await fetch(url(path))).status, path).toBe(404);
    }
    expect(upstream.seen).toHaveLength(0);
  });

  it("refuses a loop back into the daemon", async () => {
    const res = await fetch(url(`${liveBase(thread.id)}x`), { headers: { "x-tenzo-live": "1" } });
    expect(res.status).toBe(508);
  });

  it("says so when the dev server has stopped", async () => {
    await upstream.close();
    const res = await fetch(url(`${liveBase(thread.id)}x`));
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/dev server has stopped/);
  });

  it("reaches a dev server that listens on IPv6 loopback only", async () => {
    const v6 = await devServer("::1");
    try {
      daemon.engine.send(thread.id, `expose ${v6.port}`);
      await expect.poll(() => daemon.engine.livePort(thread.id)).toBe(v6.port);
      const res = await fetch(url(`${liveBase(thread.id)}x`));
      expect(res.status).toBe(200);
      expect(v6.seen).toHaveLength(1);
    } finally {
      await v6.close();
    }
  });
});

describe("live: WebSocket", () => {
  /** Opens a socket under the daemon and resolves with its first message, or the refusal. */
  function open(path: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; first?: string; ws?: WebSocket }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}${path}`, { headers });
      ws.once("message", (data) => resolve({ status: 101, first: String(data), ws }));
      ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode ?? 0 }));
      ws.on("error", reject);
    });
  }

  it("pipes an upgrade under the base to the dev server, both ways (Vite's HMR)", async () => {
    const { status, first, ws } = await open(`${liveBase(thread.id)}?token=abc`, {
      origin: `http://127.0.0.1:${daemon.port}`,
    });
    expect(status).toBe(101);
    expect(first).toBe(
      `hello ${liveBase(thread.id)}?token=abc from localhost:${upstream.port} for http://localhost:${upstream.port}`,
    );
    const echoed = new Promise<string>((resolve) => ws?.once("message", (d) => resolve(String(d))));
    ws?.send("ping");
    expect(await echoed).toBe("echo ping");
    ws?.close();
  });

  it("refuses an upgrade from a foreign origin or host, or for a thread without a live app", async () => {
    const path = liveBase(thread.id);
    expect((await open(path, { origin: "https://evil.example" })).status).toBe(403);
    expect((await open(path, { host: "evil.example" })).status).toBe(403);
    expect((await open(liveBase(other.id))).status).toBe(404);
    expect((await open("/live/thr_nopenopenopenopenope/")).status).toBe(404);
    expect(upstream.seen).toHaveLength(0);
  });

  it("leaves /ws to the daemon, refusals included", async () => {
    const hello = await open("/ws");
    expect(hello.status).toBe(101);
    expect(JSON.parse(hello.first ?? "{}").type).toBe("hello");
    hello.ws?.close();
    expect((await open("/ws", { origin: "https://evil.example" })).status).toBe(403);
  });

  it("answers 502 when the dev server has stopped", async () => {
    await upstream.close();
    expect((await open(liveBase(thread.id))).status).toBe(502);
  });
});

describe("attachments", () => {
  it("serves a thread's stored copies as images that can't run anything", async () => {
    const dir = join(home, "attachments", thread.id);
    mkdirSync(dir, { recursive: true });
    const file = "att_aaaaaaaaaaaaaaaaaaaa.png";
    writeFileSync(join(dir, file), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await fetch(url(attachmentUrl(thread.id, { file })));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("serves nothing else", async () => {
    writeFileSync(join(home, "secret.png"), "x");
    for (const path of [
      `/api/attachments/${thread.id}/att_bbbbbbbbbbbbbbbbbbbb.png`, // not there
      `/api/attachments/${thread.id}/..%2F..%2Fsecret.png`,
      `/api/attachments/${thread.id}/att_aaaaaaaaaaaaaaaaaaaa.svg`,
      `/api/attachments/..%2F..%2F/att_aaaaaaaaaaaaaaaaaaaa.png`,
      "/api/attachments/thr_x/tenzo.db",
    ]) {
      expect((await fetch(url(path))).status, path).toBe(404);
    }
    const cross = await fetch(url(attachmentUrl(thread.id, { file: "att_aaaaaaaaaaaaaaaaaaaa.png" })), {
      headers: { origin: "https://evil.example" },
    });
    expect(cross.status).toBe(403);
  });
});

describe("expose's checks", () => {
  it("takes dev-server ports only", () => {
    expect(checkPort(5173)).toBe(5173);
    for (const port of [0, 22, 80, 1023, 65_536, 5173.5, Number.NaN]) {
      expect(() => checkPort(port), String(port)).toThrow(/1024–65535/);
    }
  });

  it("keeps the page inside the base", () => {
    expect(livePath(undefined)).toBe("");
    expect(livePath("/counter")).toBe("counter");
    expect(livePath("app/?tab=2#top")).toBe("app/?tab=2#top");
    for (const path of ["../api", "a/../../b", "javascript:alert(1)", "https://x", "a\\b", "a b", "a\nb"]) {
      expect(() => livePath(path), path).toThrow(/not a page under the live base/);
    }
  });

  it("finds absolute paths outside the base", () => {
    const base = "/live/thr_x/";
    expect(outsideBase(`<script src="${base}@vite/client"></script>`, base)).toBeNull();
    expect(outsideBase('<link href="https://cdn.example/x.css"><a href="//cdn/x">', base)).toBeNull();
    expect(outsideBase('<script type="module" src="/src/main.ts"></script>', base)).toBe(
      "/src/main.ts",
    );
  });
});
