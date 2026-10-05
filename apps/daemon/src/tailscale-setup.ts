import { readConfig } from "./config.ts";
import { TenzoError } from "./errors.ts";
import { plistEnv, withPlistEnv } from "./service.ts";
import {
  describeRoute,
  parseServeStatus,
  parseStatus,
  type PlannedRoute,
  planServe,
  serveCommand,
  type ServePlan,
  type ServeRoute,
  type TailscaleRunner,
  UnreadableServeStatus,
} from "./tailscale.ts";

/**
 * `tenzo pair --tailscale`: from a Mac on a tailnet to a pairing link that works on the phone.
 * It plans the two Serve routes (tailscale.ts), adds the missing ones once you say yes, makes sure
 * the daemon runs with the settings that go with them (the launchd service's plist, after asking;
 * else it prints the command to restart with), and hands back a pairing code. Run again when all
 * is set up, it changes nothing and just pairs.
 */

/** What the daemon's `device.pair` answers. */
export interface Paired {
  code: string;
  expiresAt: string;
  origin: string | null;
}

/** The daemon's remote settings: `TENZO_ALLOWED_HOSTS`, `TENZO_LIVE_ORIGIN`, `TENZO_PUBLIC_URL`. */
export interface RemoteSettings {
  allowedHosts: string[];
  liveOrigins: string[];
  publicUrl: string | null;
}

export interface LaunchService {
  /** Its plist, for messages. */
  path: string;
  read(): string;
  write(plist: string): void;
  /** Stops the daemon it runs and starts it again from the plist. */
  reload(): void;
}

export interface SetupDeps {
  tailscale: TailscaleRunner;
  /**
   * The daemon's loopback ports: TENZO_PORT and TENZO_LIVE_PORT (the service's, when it is
   * installed: `servicePorts`).
   */
  daemonPort: number;
  livePort: number;
  /** The running daemon's settings (`daemon.settings`, read only); null when no daemon answers. */
  settings(): Promise<RemoteSettings | null>;
  /** A pairing code from the running daemon. */
  pair(): Promise<Paired>;
  /** After a restart: true once the daemon answers again, false if it doesn't in time. */
  waitForDaemon(): Promise<boolean>;
  /** The launchd service (`tenzo service install`), when it is installed. */
  service: LaunchService | null;
  /** This shell's environment: the base for a hand-started daemon's settings. */
  env: Record<string, string | undefined>;
  /** Asks a yes/no question; true for yes. */
  confirm(question: string): Promise<boolean>;
  say(line: string): void;
}

export interface SetupOptions {
  /** Change things without asking. */
  yes?: boolean;
  /** Tailnet ports asked for; else found or picked (8443, 8444). */
  httpsPort?: number | undefined;
  liveHttpsPort?: number | undefined;
}

/** A pairing code from a daemon set up for the tailnet, and the origin its link goes to; null: not yet (said why). */
export async function setUpTailscale(
  deps: SetupDeps,
  options: SetupOptions = {},
): Promise<{ origin: string; paired: Paired } | null> {
  const { say } = deps;
  const node = parseStatus(await read(deps.tailscale, ["status", "--json"]));
  const planInput = {
    dnsName: node.dnsName,
    daemonPort: deps.daemonPort,
    livePort: deps.livePort,
    httpsPort: options.httpsPort,
    liveHttpsPort: options.liveHttpsPort,
  };
  const plan = planServe(await serveRoutes(deps.tailscale, "Nothing changed."), planInput);
  for (const line of describePlan(plan)) say(line);

  const adds = [plan.daemon, plan.live].filter((r) => r.action === "add");
  if (adds.length > 0) {
    say("");
    for (const route of adds) say(`  tailscale ${serveCommand(route).join(" ")}`);
    if (!node.https) {
      say("\nHTTPS certificates aren't on for your tailnet yet: tailscale serve shows a link to turn them on. Open it, and it goes on.");
    }
    const ok = options.yes || (await deps.confirm(`\nRun ${adds.length === 1 ? "it" : "them"}? Other routes stay as they are.`));
    if (!ok) {
      say("Nothing changed.");
      return null;
    }
    for (const route of adds) {
      const code = await deps.tailscale.change(serveCommand(route));
      if (code !== 0) {
        throw new TenzoError(
          `\`tailscale ${serveCommand(route).join(" ")}\` failed (exit ${code}). Run it yourself to see why, then run this again.`,
        );
      }
    }
    const after = planServe(await serveRoutes(deps.tailscale, "The routes were added; check them with `tailscale serve status`."), {
      ...planInput,
      httpsPort: plan.daemon.httpsPort,
      liveHttpsPort: plan.live.httpsPort,
    });
    const missing = [after.daemon, after.live].filter((r) => r.action !== "keep");
    if (missing.length > 0) {
      throw new TenzoError(
        `tailscale serve finished, but ${missing.map((r) => r.origin).join(" and ")} isn't served yet. \`tailscale serve status\` shows what is.`,
      );
    }
    say("\nAdded. Other routes are as they were.");
  }

  // The daemon must know its tailnet name (or it refuses the phone's requests), its live origin
  // (or Open live points nowhere) and its public URL (the link).
  const running = await deps.settings();
  if (running && isSetUp(running, plan)) return { origin: plan.daemon.origin, paired: await deps.pair() };

  if (!deps.service) {
    const wanted = wantedSettings(running ?? settingsFromEnv(deps.env), plan);
    say(
      running
        ? "\nThe running daemon doesn't have the settings that go with these routes. Stop it and start it again with them:"
        : "\nNo daemon is running. Start it with the settings that go with these routes:",
    );
    // Where it listens and keeps its state, when this shell says: the same daemon, set up.
    const same = ["TENZO_PORT", "TENZO_LIVE_PORT", "TENZO_HOME"]
      .filter((key) => deps.env[key]?.trim() && /^[\w./:-]+$/.test(deps.env[key] ?? ""))
      .map((key) => `${key}=${deps.env[key]} `)
      .join("");
    say(`\n  ${same}${envLine(wanted)} tenzo serve\n`);
    say("Then run `tenzo pair --tailscale` again for the link. To keep it running at login with them, put the same variables before `tenzo service install`.");
    return null;
  }

  const service = deps.service;
  const plist = service.read();
  const env = plistEnv(plist);
  if (!env) {
    throw new TenzoError(`${service.path} has no environment to update; run \`tenzo service install\` again.`);
  }
  const current = settingsFromEnv(env);
  const wanted = wantedSettings(current, plan);
  const changes = settingsChanges(current, wanted);
  if (changes.length > 0) {
    say(`\nThe service (${service.path}) runs without the settings that go with these routes:`);
    for (const line of changes) say(`  ${line}`);
  } else {
    say(`\nThe service's plist has the settings, but the daemon running now doesn't${running ? "" : " (or isn't running)"}.`);
  }
  say("Restarting the daemon stops the agents running now; their threads resume on their next prompt.");
  const ok =
    options.yes ||
    (await deps.confirm(changes.length > 0 ? "Update the service's settings and restart it?" : "Restart the service?"));
  if (!ok) {
    say(
      `Nothing changed in the service. To do it yourself: \`${envLine(wanted)} tenzo service install\` from your own terminal, then \`tenzo pair --tailscale\`.`,
    );
    return null;
  }
  if (changes.length > 0) service.write(withPlistEnv(plist, { ...env, ...settingsEnv(wanted) }));
  service.reload();
  say("Restarting the service…");
  if (!(await deps.waitForDaemon())) {
    throw new TenzoError("The service didn't answer within 30 s after its restart. `tenzo service status` shows its state and log.");
  }
  const restarted = await deps.settings();
  if (!restarted || !isSetUp(restarted, plan)) {
    throw new TenzoError(
      `The daemon on 127.0.0.1:${deps.daemonPort} still runs without those settings: probably a \`tenzo serve\` started by hand, which the service can't replace. Stop it (the service takes over within 10 s), then run \`tenzo pair --tailscale\` again.`,
    );
  }
  return { origin: plan.daemon.origin, paired: await deps.pair() };
}

/**
 * The ports the service's daemon listens on, from its plist's environment (not this shell's):
 * TENZO_PORT, and TENZO_LIVE_PORT or the next port.
 */
export function servicePorts(plist: string): { port: number; livePort: number } {
  const env = plistEnv(plist) ?? {};
  const config = readConfig({ TENZO_PORT: env.TENZO_PORT, TENZO_LIVE_PORT: env.TENZO_LIVE_PORT });
  return { port: config.port, livePort: config.livePort ?? config.port + 1 };
}

/** The node's Serve routes; output it can't read stops here, saying what happened so far. */
async function serveRoutes(tailscale: TailscaleRunner, sofar: string): Promise<ServeRoute[]> {
  const out = await read(tailscale, ["serve", "status", "--json"]);
  try {
    return parseServeStatus(out);
  } catch (error) {
    if (error instanceof UnreadableServeStatus) throw new TenzoError(`${error.message} ${sofar}`);
    throw error;
  }
}

/** The plan for the person: both routes, what happens to each, and what's left alone. */
export function describePlan(plan: ServePlan): string[] {
  const row = (r: PlannedRoute) =>
    `  ${r.origin}  →  http://127.0.0.1:${r.localPort}  ${r.role === "daemon" ? "Tenzo (the Pass)" : "threads' live apps"}: ${r.action === "keep" ? "set up already" : "to add"}`;
  return [
    `Tailscale Serve on ${plan.dnsName}:`,
    row(plan.daemon),
    row(plan.live),
    ...(plan.untouched.length > 0
      ? [`Left as they are: ${plan.untouched.map((r) => `:${r.port} → ${describeRoute(r)}`).join("; ")}`]
      : []),
    ...plan.warnings.map((w) => `Note: ${w}`),
  ];
}

/** True when the daemon's settings already go with the plan. */
export function isSetUp(current: RemoteSettings, plan: ServePlan): boolean {
  return settingsChanges(current, wantedSettings(current, plan)).length === 0;
}

/**
 * The settings for the plan, keeping what else is there: the tailnet name added to the allowed
 * hosts, the live route as the one live origin on that name, the Pass's route as the public URL.
 */
export function wantedSettings(current: RemoteSettings, plan: ServePlan): RemoteSettings {
  const name = plan.dnsName;
  return {
    allowedHosts: current.allowedHosts.includes(name) ? current.allowedHosts : [...current.allowedHosts, name],
    liveOrigins: [...current.liveOrigins.filter((o) => hostOf(o) !== name), plan.live.origin],
    publicUrl: plan.daemon.origin,
  };
}

export function settingsFromEnv(env: Record<string, string | undefined>): RemoteSettings {
  const list = (raw: string | undefined) =>
    (raw ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");
  return {
    allowedHosts: list(env.TENZO_ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    liveOrigins: list(env.TENZO_LIVE_ORIGIN).map(originOf),
    publicUrl: env.TENZO_PUBLIC_URL?.trim() ? originOf(env.TENZO_PUBLIC_URL.trim()) : null,
  };
}

export function settingsEnv(s: RemoteSettings): Record<string, string> {
  return {
    ...(s.allowedHosts.length > 0 ? { TENZO_ALLOWED_HOSTS: s.allowedHosts.join(",") } : {}),
    ...(s.liveOrigins.length > 0 ? { TENZO_LIVE_ORIGIN: s.liveOrigins.join(",") } : {}),
    ...(s.publicUrl ? { TENZO_PUBLIC_URL: s.publicUrl } : {}),
  };
}

/** `TENZO_ALLOWED_HOSTS=… TENZO_LIVE_ORIGIN=… TENZO_PUBLIC_URL=…`, ready for a shell. */
export function envLine(s: RemoteSettings): string {
  return Object.entries(settingsEnv(s))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

/** What differs, a line per variable: `TENZO_PUBLIC_URL: (unset) → https://…:8443`. */
export function settingsChanges(from: RemoteSettings, to: RemoteSettings): string[] {
  const before = settingsEnv(from);
  const after = settingsEnv(to);
  const same = (a: string | undefined, b: string | undefined) =>
    (a ?? "").split(",").sort().join(",") === (b ?? "").split(",").sort().join(",");
  return ["TENZO_ALLOWED_HOSTS", "TENZO_LIVE_ORIGIN", "TENZO_PUBLIC_URL"]
    .filter((key) => !same(before[key], after[key]))
    .map((key) => `${key}: ${before[key] ?? "(unset)"} → ${after[key] ?? "(unset)"}`);
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

async function read(tailscale: TailscaleRunner, args: string[]): Promise<string> {
  const run = await tailscale.read(args);
  if (run.code !== 0) {
    const why = run.stderr.trim().split("\n")[0] ?? "";
    throw new TenzoError(
      `\`tailscale ${args.join(" ")}\` failed${why ? `: ${why}` : ` (exit ${run.code})`}. Is Tailscale running and signed in?`,
    );
  }
  return run.stdout;
}
