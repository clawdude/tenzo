import { spawn } from "node:child_process";
import { TenzoError } from "./errors.ts";

/**
 * Tailscale Serve for `tenzo pair --tailscale` (docs/REMOTE.md): reads this node's MagicDNS name
 * and its Serve routes, and plans the two HTTPS routes Tenzo needs (the Pass, and threads' live
 * apps on an origin of their own). Everything here is pure but the runner; the runner is the only
 * way to the `tailscale` binary, so tests use a fake one.
 *
 * Rules: never touch a route Tenzo didn't plan (no `off`, no `reset`, no change to a route that
 * serves something else), and never raw TCP (`--tcp`, `--tls-terminated-tcp`): those add no
 * forwarding headers and let a client say `Host: localhost`, so every client through them would
 * count as the Mac itself, with no pairing.
 */

export interface TailscaleRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TailscaleRunner {
  /** A read-only command (`status --json`, `serve status --json`), output captured. */
  read(args: readonly string[]): Promise<TailscaleRun>;
  /**
   * A command that changes Tailscale's config, run on the terminal so tailscale's own prompts
   * show (a first Serve on a tailnet asks to enable HTTPS in the browser). Its exit code.
   */
  change(args: readonly string[]): Promise<number>;
}

/** Where the CLI is when it isn't on PATH: inside the macOS app. */
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** The real `tailscale`: on PATH, else the macOS app's. */
export function systemTailscale(): TailscaleRunner {
  let binary: string | undefined;
  const candidates = process.platform === "darwin" ? ["tailscale", MAC_APP_CLI] : ["tailscale"];

  async function run(args: readonly string[], interactive: boolean): Promise<TailscaleRun> {
    for (const candidate of binary ? [binary] : candidates) {
      const result = await spawnOnce(candidate, args, interactive);
      if (result === "missing") continue;
      binary = candidate;
      return result;
    }
    throw new TenzoError(
      "No tailscale CLI found (not on PATH, nor in /Applications/Tailscale.app). Install Tailscale and sign in, then run this again: https://tailscale.com/download",
    );
  }
  return {
    read: (args) => run(args, false),
    change: async (args) => (await run(args, true)).code,
  };
}

function spawnOnce(
  command: string,
  args: readonly string[],
  interactive: boolean,
): Promise<TailscaleRun | "missing"> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
      // Reads are quick; a change may wait while you enable HTTPS in the browser.
      ...(interactive ? {} : { timeout: 15_000 }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") resolve("missing");
      else resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// What `tailscale status --json` says about this node.

export interface TailscaleNode {
  /** This node's MagicDNS name, lower case, no trailing dot: `my-mac.tail1234.ts.net`. */
  dnsName: string;
  /** Whether the tailnet has HTTPS certificates on (Serve's `--https` needs them). */
  https: boolean;
}

/** A MagicDNS name: dot-separated labels of a-z, 0-9 and inner hyphens, at least two. */
const DNS_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Parses `tailscale status --json`; a node that can't serve yet is an error saying what to do. */
export function parseStatus(json: string): TailscaleNode {
  const status = parseJson(json, "tailscale status --json") as {
    BackendState?: unknown;
    Self?: { DNSName?: unknown; Capabilities?: unknown };
    CertDomains?: unknown;
    CurrentTailnet?: { MagicDNSEnabled?: unknown } | null;
  } | null;
  const state = typeof status?.BackendState === "string" ? status.BackendState : "unknown";
  if (state !== "Running") {
    throw new TenzoError(
      `Tailscale isn't connected (its state is ${state}). Run \`tailscale up\` (or sign in from the menu bar app), then run this again.`,
    );
  }
  const raw = status?.Self?.DNSName;
  const dnsName = typeof raw === "string" ? raw.trim().toLowerCase().replace(/\.$/, "") : "";
  if (dnsName === "" || status?.CurrentTailnet?.MagicDNSEnabled === false) {
    throw new TenzoError(
      "This machine has no MagicDNS name, and Serve's HTTPS needs one. Turn MagicDNS on in the Tailscale admin console (DNS page), then run this again.",
    );
  }
  // It goes into commands, settings and a plist: a host name, labels of [a-z0-9-], or nothing.
  if (!DNS_NAME.test(dnsName) || dnsName.length > 253) {
    throw new TenzoError(
      `Tailscale gives this machine the name "${dnsName}", which isn't a host name Tenzo can use. Check \`tailscale status\`.`,
    );
  }
  const certs = Array.isArray(status?.CertDomains) && status.CertDomains.length > 0;
  const caps = status?.Self?.Capabilities;
  const https = certs || (Array.isArray(caps) && caps.includes("https"));
  return { dnsName, https };
}

// What `tailscale serve status --json` says is served.

export type RouteKind = "https" | "http" | "tcp" | "tls-terminated-tcp";

/** One port this node serves on its tailnet, from any source (`--bg` or a foreground serve). */
export interface ServeRoute {
  port: number;
  kind: RouteKind;
  /** Web handlers by mount path: a proxy target (`http://127.0.0.1:4780`), or `text:`/`path:` … */
  handlers: Record<string, string>;
  /** Raw TCP routes: where it forwards (`127.0.0.1:4780`). */
  tcpForward: string | null;
  /** Open to the public internet (Funnel). */
  funnel: boolean;
  /** Set by a `tailscale serve` running in the foreground: gone when it stops. */
  foreground: boolean;
}

/**
 * `tailscale serve status --json` in a shape this code doesn't know. Tenzo plans routes only when
 * it can see every route there is: misreading the config as empty could put Tenzo's routes over
 * someone else's, so anything unexpected stops the setup instead.
 */
export class UnreadableServeStatus extends TenzoError {
  constructor(why: string) {
    super(
      `Can't read \`tailscale serve status --json\` (${why}). Tenzo changes Serve only when it can see every route; check \`tailscale serve status\`, or set the routes up by hand (docs/REMOTE.md).`,
    );
  }
}

/** The keys of ipn.ServeConfig this reads; an object with none of them is something else. */
const SERVE_KEYS = ["TCP", "Web", "AllowFunnel", "Foreground", "Services"];

/**
 * Parses `tailscale serve status --json` (ipn.ServeConfig) into routes by port. Empty output,
 * `null` and `{}` mean nothing is served; any other shape it doesn't know is an error
 * (`UnreadableServeStatus`), never "nothing". Tailscale Services (`Services`, a VIP of their own)
 * share no ports with the node, so they are left out; foreground serves are in.
 */
export function parseServeStatus(json: string): ServeRoute[] {
  let raw: unknown;
  try {
    raw = json.trim() === "" ? null : JSON.parse(json);
  } catch {
    throw new UnreadableServeStatus("not JSON");
  }
  const routes = new Map<number, ServeRoute>();
  const add = (config: unknown, where: string, foreground: boolean) => {
    const cfg = object(config, where);
    const keys = Object.keys(cfg);
    if (keys.length > 0 && !keys.some((k) => SERVE_KEYS.includes(k))) {
      throw new UnreadableServeStatus(`${where} has none of ${SERVE_KEYS.join(", ")}`);
    }
    for (const key of SERVE_KEYS) {
      if (cfg[key] !== undefined && cfg[key] !== null) object(cfg[key], `${where}.${key}`);
    }
    for (const [key, value] of Object.entries(maybe(cfg.TCP))) {
      const port = validPort(key, `${where}.TCP`);
      const tcp = object(value, `${where}.TCP["${key}"]`);
      for (const flag of ["HTTPS", "HTTP"]) {
        if (tcp[flag] !== undefined && typeof tcp[flag] !== "boolean") {
          throw new UnreadableServeStatus(`${where}.TCP["${key}"].${flag} isn't true or false`);
        }
      }
      for (const field of ["TCPForward", "TerminateTLS"]) {
        if (tcp[field] !== undefined && typeof tcp[field] !== "string") {
          throw new UnreadableServeStatus(`${where}.TCP["${key}"].${field} isn't text`);
        }
      }
      const kind: RouteKind = tcp.HTTPS
        ? "https"
        : tcp.HTTP
          ? "http"
          : tcp.TerminateTLS
            ? "tls-terminated-tcp"
            : "tcp";
      routes.set(port, {
        port,
        kind,
        handlers: {},
        tcpForward: kind === "tcp" || kind === "tls-terminated-tcp" ? ((tcp.TCPForward as string | undefined) ?? null) : null,
        funnel: false,
        foreground,
      });
    }
    for (const [hostPort, value] of Object.entries(maybe(cfg.Web))) {
      const port = validPort(hostPort.slice(hostPort.lastIndexOf(":") + 1), `${where}.Web["${hostPort}"]`);
      const web = object(value, `${where}.Web["${hostPort}"]`);
      const route =
        routes.get(port) ??
        // A Web entry without its TCP entry: unusual, but its port is taken all the same.
        { port, kind: "https" as const, handlers: {}, tcpForward: null, funnel: false, foreground };
      routes.set(port, route);
      const handlers = web.Handlers === undefined || web.Handlers === null ? {} : object(web.Handlers, `${where}.Web["${hostPort}"].Handlers`);
      for (const [path, handler] of Object.entries(handlers)) {
        route.handlers[path] = describeHandler(object(handler, `${where}.Web["${hostPort}"].Handlers["${path}"]`));
      }
    }
    for (const [hostPort, on] of Object.entries(maybe(cfg.AllowFunnel))) {
      const port = validPort(hostPort.slice(hostPort.lastIndexOf(":") + 1), `${where}.AllowFunnel["${hostPort}"]`);
      if (typeof on !== "boolean") throw new UnreadableServeStatus(`${where}.AllowFunnel["${hostPort}"] isn't true or false`);
      const route = routes.get(port);
      if (route && on) route.funnel = true;
    }
    for (const [session, value] of Object.entries(maybe(cfg.Foreground))) {
      add(value, `Foreground["${session}"]`, true);
    }
  };
  if (raw !== null) add(raw, "the top level", false);
  return [...routes.values()].sort((a, b) => a.port - b.port);
}

/** A plain object (not an array, not null), or the error saying where it isn't. */
function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnreadableServeStatus(`${where} isn't an object`);
  }
  return value as Record<string, unknown>;
}

/** An optional map, already checked by `object`. */
function maybe(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function validPort(text: string, where: string): number {
  const port = /^\d{1,5}$/.test(text) ? Number(text) : Number.NaN;
  if (!isPort(port)) throw new UnreadableServeStatus(`${where}: "${text}" isn't a port`);
  return port;
}

/** A TCP port: a whole number from 1 to 65535. */
export function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function describeHandler(handler: Record<string, unknown>): string {
  if (typeof handler.Proxy === "string") return handler.Proxy;
  if (typeof handler.Path === "string") return `path:${handler.Path}`;
  if (typeof handler.Text === "string") return "text";
  if (typeof handler.Redirect === "string") return `redirect:${handler.Redirect}`;
  return "something else";
}

function parseJson(json: string, what: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new TenzoError(`Couldn't read the output of \`${what}\`: not JSON. Is this Tailscale 1.52 or later?`);
  }
}

/**
 * The loopback port an HTTP proxy target points at, or null for anything else (https targets,
 * other hosts, a path). `tailscale serve 4780` is stored as `http://127.0.0.1:4780`.
 */
export function loopbackPort(target: string): number | null {
  let url: URL;
  try {
    url = new URL(/^[a-z+]+:\/\//.test(target) ? target : `http://${target}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
  if (url.pathname !== "/" || url.search !== "") return null;
  const port = Number(url.port);
  return isPort(port) ? port : null;
}

/** A route Tenzo can use as it is: HTTPS, with `/` proxied to that loopback port. */
export function servesPort(route: ServeRoute, localPort: number): boolean {
  const root = route.handlers["/"];
  return route.kind === "https" && root !== undefined && loopbackPort(root) === localPort;
}

/** The route's target in a line: `http://127.0.0.1:18789`, `tcp 127.0.0.1:22`, … */
export function describeRoute(route: ServeRoute): string {
  if (route.kind === "tcp" || route.kind === "tls-terminated-tcp") {
    return `${route.kind} ${route.tcpForward ?? "?"}`;
  }
  const handlers = Object.entries(route.handlers);
  if (handlers.length === 0) return route.kind;
  const paths = handlers.map(([path, target]) => (path === "/" ? target : `${path} → ${target}`)).join(", ");
  return route.kind === "https" ? paths : `${route.kind} ${paths}`;
}

// The plan.

export const DEFAULT_HTTPS_PORT = 8443;
export const DEFAULT_LIVE_HTTPS_PORT = 8444;

export interface PlannedRoute {
  role: "daemon" | "live";
  /** The tailnet port, on this node's name. */
  httpsPort: number;
  /** The loopback port it proxies to. */
  localPort: number;
  /** keep: Serve already does this; add: `tailscale serve` will. */
  action: "keep" | "add";
  /** `https://my-mac.tail1234.ts.net:8443` */
  origin: string;
}

export interface ServePlan {
  dnsName: string;
  daemon: PlannedRoute;
  live: PlannedRoute;
  /** Routes that serve something else: never changed. */
  untouched: ServeRoute[];
  warnings: string[];
}

export interface PlanInput {
  dnsName: string;
  /** The daemon's loopback port (TENZO_PORT) and its live listener's (TENZO_LIVE_PORT). */
  daemonPort: number;
  livePort: number;
  /** Tailnet ports asked for (`--https-port`, `--live-https-port`); else found or chosen. */
  httpsPort?: number | undefined;
  liveHttpsPort?: number | undefined;
}

/**
 * Plans the two routes: a route that already serves the port is kept (on whatever tailnet port it
 * has, unless another was asked for); a missing one goes on the asked port, else the default
 * (8443 for the Pass, 8444 for live apps), else the next free port above it. A port that serves
 * something else is never taken over: asking for it is an error, and the default moves aside.
 * A raw TCP route to Tenzo is refused outright: it lets everyone through as local.
 */
export function planServe(routes: readonly ServeRoute[], input: PlanInput): ServePlan {
  const { dnsName, daemonPort, livePort } = input;
  for (const route of routes) {
    if (route.kind !== "tcp" && route.kind !== "tls-terminated-tcp") continue;
    const target = route.tcpForward ? loopbackPort(route.tcpForward) : null;
    if (target === daemonPort || target === livePort) {
      throw new TenzoError(
        `Tailscale forwards raw TCP from port ${route.port} to Tenzo (${route.tcpForward}). Through raw TCP every client looks like this Mac itself, with no pairing at all. Remove it with \`tailscale serve --${route.kind}=${route.port} off\`, then run this again; Tenzo only ever uses --https.`,
      );
    }
  }
  if (input.httpsPort !== undefined && input.httpsPort === input.liveHttpsPort) {
    throw new TenzoError("The Pass and live apps need two different HTTPS ports.");
  }
  const reserved = new Set<number>();
  const pick = (
    role: PlannedRoute["role"],
    localPort: number,
    asked: number | undefined,
    fallback: number,
    /** The other route's default: a moved-aside route doesn't take it. */
    avoid: number,
  ) => {
    const at = (port: number) => routes.find((r) => r.port === port);
    let httpsPort: number;
    let action: PlannedRoute["action"];
    if (asked !== undefined) {
      if (!isPort(asked)) throw new TenzoError(`${asked} isn't a port (1 to 65535).`);
      const route = at(asked);
      if (route && !servesPort(route, localPort)) {
        throw new TenzoError(
          `Tailscale already serves port ${asked} (${describeRoute(route)}), and Tenzo doesn't change routes it didn't make. Pick another port, or leave the option out to have one picked.`,
        );
      }
      httpsPort = asked;
      action = route ? "keep" : "add";
    } else {
      const existing = routes.filter((r) => servesPort(r, localPort) && !reserved.has(r.port));
      const found = existing.find((r) => r.port === fallback) ?? existing.find((r) => !r.foreground) ?? existing[0];
      if (found) {
        httpsPort = found.port;
        action = "keep";
      } else {
        httpsPort = fallback;
        while (at(httpsPort) || reserved.has(httpsPort) || httpsPort === avoid) httpsPort++;
        if (!isPort(httpsPort)) throw new TenzoError("No free HTTPS port left on this node for Tenzo.");
        action = "add";
      }
    }
    reserved.add(httpsPort);
    return { role, httpsPort, localPort, action, origin: httpsOrigin(dnsName, httpsPort) };
  };
  // The live route's own port, asked for or already serving it, is never the Pass's fallback.
  const liveKnown =
    input.liveHttpsPort ?? routes.find((r) => servesPort(r, livePort))?.port ?? DEFAULT_LIVE_HTTPS_PORT;
  const daemon = pick("daemon", daemonPort, input.httpsPort, DEFAULT_HTTPS_PORT, liveKnown);
  if (input.liveHttpsPort === daemon.httpsPort) {
    throw new TenzoError(`Port ${daemon.httpsPort} is the Pass's; live apps need another HTTPS port.`);
  }
  const live = pick("live", livePort, input.liveHttpsPort, DEFAULT_LIVE_HTTPS_PORT, DEFAULT_HTTPS_PORT);

  const ours = new Set([daemon.httpsPort, live.httpsPort]);
  const warnings: string[] = [];
  for (const planned of [daemon, live]) {
    const route = routes.find((r) => r.port === planned.httpsPort);
    if (!route) continue;
    if (route.funnel) {
      warnings.push(
        `Port ${route.port} is on Funnel: open to the whole internet, not just your tailnet. Tenzo still asks for pairing, but \`tailscale funnel --https=${route.port} off\` keeps it tailnet-only.`,
      );
    }
    if (route.foreground) {
      warnings.push(`Port ${route.port} comes from a \`tailscale serve\` running in the foreground: it goes away when that stops.`);
    }
    const extra = Object.keys(route.handlers).filter((path) => path !== "/");
    if (extra.length > 0) {
      warnings.push(`Port ${route.port} also serves ${extra.join(", ")}, which hide Tenzo's pages under those paths.`);
    }
  }
  return {
    dnsName,
    daemon,
    live,
    untouched: routes.filter((r) => !ours.has(r.port)),
    warnings,
  };
}

/** `https://name` on 443, else `https://name:port`. */
export function httpsOrigin(dnsName: string, port: number): string {
  return port === 443 ? `https://${dnsName}` : `https://${dnsName}:${port}`;
}

/**
 * The one command that adds a planned route, in Serve's HTTPS mode. Built here only, and checked:
 * nothing Tenzo runs can turn a route off, reset Serve, or forward raw TCP.
 */
export function serveCommand(route: PlannedRoute): string[] {
  return assertSafeServe(["serve", "--bg", `--https=${route.httpsPort}`, `http://127.0.0.1:${route.localPort}`]);
}

/** Refuses any tailscale command that isn't an HTTPS `serve --bg` of one loopback target. */
export function assertSafeServe(args: readonly string[]): string[] {
  const [sub, bg, https, target, ...rest] = args;
  const port = /^--https=(\d{1,5})$/.exec(https ?? "")?.[1];
  const ok =
    sub === "serve" &&
    bg === "--bg" &&
    port !== undefined &&
    isPort(Number(port)) &&
    target !== undefined &&
    loopbackPort(target) !== null &&
    rest.length === 0;
  if (!ok) {
    throw new TenzoError(
      `Refusing to run \`tailscale ${args.join(" ")}\`: Tenzo only adds HTTPS Serve routes (never --tcp, --tls-terminated-tcp, off or reset).`,
    );
  }
  return [...args];
}
