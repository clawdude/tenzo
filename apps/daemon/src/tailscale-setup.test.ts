import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { launchAgentPlist, plistEnv, SERVICE_LABEL, withPlistEnv } from "./service.ts";
import type { TailscaleRunner } from "./tailscale.ts";
import { NAME, SERVE_SET_UP, SERVE_UNRELATED, STATUS_1_102 } from "./tailscale-fixtures.ts";
import {
  type LaunchService,
  type Paired,
  type RemoteSettings,
  type SetupDeps,
  setUpTailscale,
  settingsFromEnv,
} from "./tailscale-setup.ts";
import { removeTempDirs, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

const PASS = `https://${NAME}:8443`;
const LIVE = `https://${NAME}:8444`;
const SET_UP: RemoteSettings = { allowedHosts: [NAME], liveOrigins: [LIVE], publicUrl: PASS };

type ServeJson = { TCP?: Record<string, object>; Web?: Record<string, object> };

/** A tailscale that keeps its serve config in memory; `serve --bg --https=P target` adds to it. */
function fakeTailscale(serve: ServeJson, status: object = STATUS_1_102) {
  const config: ServeJson = structuredClone(serve);
  const reads: string[][] = [];
  const changes: string[][] = [];
  const runner: TailscaleRunner = {
    read: async (args) => {
      reads.push([...args]);
      const out = args[0] === "status" ? status : config;
      return { code: 0, stdout: JSON.stringify(out), stderr: "" };
    },
    change: async (args) => {
      changes.push([...args]);
      const port = /^--https=(\d+)$/.exec(args[2] ?? "")?.[1];
      if (args[0] !== "serve" || args[1] !== "--bg" || !port) return 1;
      config.TCP = { ...config.TCP, [port]: { HTTPS: true } };
      config.Web = { ...config.Web, [`${NAME}:${port}`]: { Handlers: { "/": { Proxy: args[3] } } } };
      return 0;
    },
  };
  return { runner, config, reads, changes };
}

/** A daemon whose settings can change on restart; null settings: not running. */
function fakeDaemon(settings: RemoteSettings | null) {
  const daemon = {
    settings,
    pairs: 0,
    pair: async (): Promise<Paired | null> => {
      if (!daemon.settings) return null;
      daemon.pairs++;
      return {
        code: `code${daemon.pairs}`,
        expiresAt: "2026-10-05T12:10:00.000Z",
        origin: daemon.settings.publicUrl,
        allowedHosts: daemon.settings.allowedHosts,
        liveOrigins: daemon.settings.liveOrigins,
      };
    },
  };
  return daemon;
}

/** A launchd service whose plist is a file in a temp dir; reloading restarts the fake daemon from it. */
function fakeService(env: Record<string, string>, daemon: ReturnType<typeof fakeDaemon>, { handRun = false } = {}) {
  const path = join(tempDir("launchagents"), `${SERVICE_LABEL}.plist`);
  writeFileSync(
    path,
    launchAgentPlist({ node: "/opt/homebrew/bin/node", cli: "/x/cli.ts", cwd: "/x", env, log: "/h/daemon.log" }),
  );
  const service = {
    reloads: 0,
    path,
    read: () => readFileSync(path, "utf8"),
    write: (plist: string) => writeFileSync(path, plist),
    reload: () => {
      service.reloads++;
      // A daemon started by hand keeps the port: the service can't replace it.
      if (!handRun) daemon.settings = settingsFromEnv(plistEnv(readFileSync(path, "utf8")) ?? {});
    },
  } satisfies LaunchService & { reloads: number };
  return service;
}

function deps(
  over: Partial<SetupDeps> & Pick<SetupDeps, "tailscale" | "pair">,
  answers: boolean[] = [],
): SetupDeps & { said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  return {
    daemonPort: 4780,
    livePort: 4781,
    waitForDaemon: async () => true,
    service: null,
    env: {},
    confirm: async (q) => {
      asked.push(q);
      return answers.shift() ?? false;
    },
    say: (line) => said.push(line),
    ...over,
    said,
    asked,
  };
}

describe("tenzo pair --tailscale", () => {
  it("with everything set up, changes nothing and just pairs", async () => {
    const ts = fakeTailscale(SERVE_SET_UP);
    const daemon = fakeDaemon(SET_UP);
    const d = deps({ tailscale: ts.runner, pair: daemon.pair });
    const done = await setUpTailscale(d);
    expect(done).toEqual({ origin: PASS, paired: expect.objectContaining({ code: "code1" }) });
    expect(ts.changes).toEqual([]);
    expect(d.asked).toEqual([]);
    expect(d.said.join("\n")).toContain("set up already");
    expect(d.said.join("\n")).toContain(":443 → http://127.0.0.1:18789");
  });

  it("from zero with the service: adds both routes after asking, leaves the unrelated one, updates the plist and pairs", async () => {
    const ts = fakeTailscale(SERVE_UNRELATED);
    const daemon = fakeDaemon({ allowedHosts: [], liveOrigins: [], publicUrl: null });
    const service = fakeService(
      { PATH: "/usr/bin", TENZO_HOME: "/h", TENZO_ALLOWED_HOSTS: "other.example", ANTHROPIC_API_KEY: "sk-x" },
      daemon,
    );
    const before = service.read();
    const d = deps({ tailscale: ts.runner, pair: daemon.pair, service }, [true, true]);
    const done = await setUpTailscale(d);

    expect(ts.changes).toEqual([
      ["serve", "--bg", "--https=8443", "http://127.0.0.1:4780"],
      ["serve", "--bg", "--https=8444", "http://127.0.0.1:4781"],
    ]);
    // The unrelated route is exactly as it was.
    expect(ts.config.TCP?.["443"]).toEqual(SERVE_UNRELATED.TCP["443"]);
    expect(ts.config.Web?.[`${NAME}:443`]).toEqual(SERVE_UNRELATED.Web[`${NAME}:443`]);
    expect(d.asked).toHaveLength(2);
    expect(d.asked[0]).toMatch(/Run them\? Other routes stay as they are/);
    expect(d.asked[1]).toMatch(/Update the service's settings and restart it/);

    expect(plistEnv(service.read())).toEqual({
      PATH: "/usr/bin",
      TENZO_HOME: "/h",
      ANTHROPIC_API_KEY: "sk-x",
      TENZO_ALLOWED_HOSTS: `other.example,${NAME}`,
      TENZO_LIVE_ORIGIN: LIVE,
      TENZO_PUBLIC_URL: PASS,
    });
    // Nothing else in the plist moved.
    expect(service.read()).toBe(withPlistEnv(before, plistEnv(service.read()) ?? {}));
    expect(service.reloads).toBe(1);
    expect(done?.origin).toBe(PASS);
    expect(done?.paired.allowedHosts).toEqual(["other.example", NAME]);
  });

  it("with --yes, asks nothing", async () => {
    const ts = fakeTailscale({});
    const daemon = fakeDaemon({ allowedHosts: [], liveOrigins: [], publicUrl: null });
    const service = fakeService({ PATH: "/usr/bin" }, daemon);
    const d = deps({ tailscale: ts.runner, pair: daemon.pair, service });
    const done = await setUpTailscale(d, { yes: true });
    expect(d.asked).toEqual([]);
    expect(ts.changes).toHaveLength(2);
    expect(done?.origin).toBe(PASS);
  });

  it("changes nothing when you say no to the routes", async () => {
    const ts = fakeTailscale(SERVE_UNRELATED);
    const daemon = fakeDaemon({ allowedHosts: [], liveOrigins: [], publicUrl: null });
    const d = deps({ tailscale: ts.runner, pair: daemon.pair }, [false]);
    expect(await setUpTailscale(d)).toBeNull();
    expect(ts.changes).toEqual([]);
    expect(daemon.pairs).toBe(0);
    expect(d.said).toContain("Nothing changed.");
  });

  it("leaves the service alone when you say no to restarting it, and says how to do it", async () => {
    const ts = fakeTailscale(SERVE_SET_UP);
    const daemon = fakeDaemon({ allowedHosts: [], liveOrigins: [], publicUrl: null });
    const service = fakeService({ PATH: "/usr/bin" }, daemon);
    const before = service.read();
    const d = deps({ tailscale: ts.runner, pair: daemon.pair, service }, [false]);
    expect(await setUpTailscale(d)).toBeNull();
    expect(service.read()).toBe(before);
    expect(service.reloads).toBe(0);
    expect(d.said.join("\n")).toContain(
      `TENZO_ALLOWED_HOSTS=${NAME} TENZO_LIVE_ORIGIN=${LIVE} TENZO_PUBLIC_URL=${PASS} tenzo service install`,
    );
  });

  it("without the service, prints the settings to restart the daemon with, keeping the ones it has", async () => {
    const ts = fakeTailscale(SERVE_SET_UP);
    const daemon = fakeDaemon({
      allowedHosts: ["lan-box.local"],
      // An old live route on the same name goes; another name's stays.
      liveOrigins: [`https://${NAME}:9444`, "https://lan-box.local:4781"],
      publicUrl: null,
    });
    const d = deps({ tailscale: ts.runner, pair: daemon.pair });
    expect(await setUpTailscale(d)).toBeNull();
    expect(ts.changes).toEqual([]);
    expect(d.said.join("\n")).toContain(
      `  TENZO_ALLOWED_HOSTS=lan-box.local,${NAME} TENZO_LIVE_ORIGIN=https://lan-box.local:4781,${LIVE} TENZO_PUBLIC_URL=${PASS} tenzo serve`,
    );
    expect(d.said.join("\n")).toContain("run `tenzo pair --tailscale` again");
  });

  it("without a daemon or the service, starts from this shell's settings", async () => {
    const ts = fakeTailscale(SERVE_SET_UP);
    const d = deps({ tailscale: ts.runner, pair: fakeDaemon(null).pair, env: { TENZO_ALLOWED_HOSTS: "x.example" } });
    expect(await setUpTailscale(d)).toBeNull();
    expect(d.said.join("\n")).toContain("No daemon is running");
    expect(d.said.join("\n")).toContain(`TENZO_ALLOWED_HOSTS=x.example,${NAME} `);
  });

  it("restarts a service whose plist is right but whose daemon isn't running with it", async () => {
    const ts = fakeTailscale(SERVE_SET_UP);
    const daemon = fakeDaemon(null);
    const env = { PATH: "/usr/bin", TENZO_ALLOWED_HOSTS: NAME, TENZO_LIVE_ORIGIN: LIVE, TENZO_PUBLIC_URL: PASS };
    const service = fakeService(env, daemon);
    const before = service.read();
    const d = deps({ tailscale: ts.runner, pair: daemon.pair, service }, [true]);
    const done = await setUpTailscale(d);
    expect(d.asked).toEqual(["Restart the service?"]);
    expect(service.read()).toBe(before);
    expect(service.reloads).toBe(1);
    expect(done?.paired.code).toBe("code1");
  });

  it("says so when a hand-started daemon keeps the port after the service restarts", async () => {
    const ts = fakeTailscale(SERVE_SET_UP);
    const daemon = fakeDaemon({ allowedHosts: [], liveOrigins: [], publicUrl: null });
    const service = fakeService({ PATH: "/usr/bin" }, daemon, { handRun: true });
    const d = deps({ tailscale: ts.runner, pair: daemon.pair, service }, [true]);
    await expect(setUpTailscale(d)).rejects.toThrow(/started by hand/);
  });

  it("fails when the service doesn't come back", async () => {
    const ts = fakeTailscale(SERVE_SET_UP);
    const daemon = fakeDaemon(null);
    const service = fakeService({ PATH: "/usr/bin" }, daemon);
    const d = deps({ tailscale: ts.runner, pair: daemon.pair, service, waitForDaemon: async () => false }, [true]);
    await expect(setUpTailscale(d)).rejects.toThrow(/didn't answer within 30 s/);
  });

  it("refuses a raw TCP route to Tenzo before changing anything", async () => {
    const ts = fakeTailscale({ TCP: { "8443": { TCPForward: "127.0.0.1:4780" } } });
    const d = deps({ tailscale: ts.runner, pair: fakeDaemon(SET_UP).pair }, [true]);
    await expect(setUpTailscale(d)).rejects.toThrow(/raw TCP/);
    expect(ts.changes).toEqual([]);
  });

  it("stops at a node that isn't signed in, or a tailscale that fails", async () => {
    const out = fakeTailscale({}, { BackendState: "NeedsLogin", Self: { DNSName: "" } });
    await expect(setUpTailscale(deps({ tailscale: out.runner, pair: fakeDaemon(SET_UP).pair }))).rejects.toThrow(
      /tailscale up/,
    );
    const broken: TailscaleRunner = {
      read: async () => ({ code: 1, stdout: "", stderr: "failed to connect to local tailscaled; it doesn't appear to be running\n" }),
      change: async () => 0,
    };
    await expect(setUpTailscale(deps({ tailscale: broken, pair: fakeDaemon(SET_UP).pair }))).rejects.toThrow(
      /`tailscale status --json` failed: failed to connect to local tailscaled/,
    );
  });

  it("fails when tailscale serve fails, or doesn't take", async () => {
    const failing = fakeTailscale({});
    failing.runner.change = async () => 1;
    await expect(
      setUpTailscale(deps({ tailscale: failing.runner, pair: fakeDaemon(SET_UP).pair }, [true])),
    ).rejects.toThrow(/--https=8443 http:\/\/127.0.0.1:4780` failed \(exit 1\)/);
    const ignoring = fakeTailscale({});
    ignoring.runner.change = async () => 0;
    await expect(
      setUpTailscale(deps({ tailscale: ignoring.runner, pair: fakeDaemon(SET_UP).pair }, [true])),
    ).rejects.toThrow(/isn't served yet/);
  });
});

describe("plistEnv and withPlistEnv", () => {
  it("read and replace the service's environment, escapes and all, leaving the rest", () => {
    const env = { PATH: "/usr/bin", ODD: `a & b < c > d "e" 'f'` };
    const plist = launchAgentPlist({ node: "/n", cli: "/c", cwd: "/w", env, log: "/l" });
    expect(plistEnv(plist)).toEqual(env);
    const next = { ...env, TENZO_PUBLIC_URL: PASS };
    const updated = withPlistEnv(plist, next);
    expect(updated).toBe(launchAgentPlist({ node: "/n", cli: "/c", cwd: "/w", env: next, log: "/l" }));
    expect(plistEnv("<plist></plist>")).toBeNull();
    expect(() => withPlistEnv("<plist></plist>", next)).toThrow(/service install/);
  });
});
