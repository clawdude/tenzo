import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { claudeEnv } from "./agent/claude.ts";
import type { DaemonConfig } from "./config.ts";
import { TenzoError } from "./errors.ts";
import { ensureHome } from "./home.ts";

/**
 * `tenzo service`: the daemon as a macOS launchd user agent, so it starts at login and comes
 * back if it dies. It runs `tenzo serve` from this checkout, with the Node and the environment
 * it was installed from: the same PATH, TENZO_* settings and Claude configuration as the shell,
 * so threads run as they would from the terminal. Reinstall after changing any of them.
 */

export const SERVICE_LABEL = "dev.tenzo.daemon";

export function plistPath(home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

/** Variables that describe the terminal or session the install ran in, not the user's setup. */
const SESSION_VARS = new Set([
  "_",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "TMPDIR", // launchd gives each agent its own
  "SSH_AUTH_SOCK", // launchd's own agent socket is the one that outlives this login
  "SECURITYSESSIONID",
  "LaunchInstanceID",
  "Apple_PubSub_Socket_Render",
  "COLORTERM",
  "STY",
  "WINDOW",
  "INIT_CWD",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "AI_AGENT", // set by an agent the install ran under
  "GIT_EDITOR", // likewise: an agent's non-interactive editor
  "NoDefaultCurrentDirectoryInExePath",
  "COREPACK_ENABLE_AUTO_PIN",
  "OSLogRateLimit",
]);
const SESSION_PREFIXES = [
  "TERM",
  "TMUX",
  "SSH_",
  "XPC_",
  "__CF",
  "ITERM_",
  "VSCODE_",
  "KITTY_",
  "WEZTERM_",
  "GHOSTTY_",
  "ALACRITTY_",
  "npm_",
  "PNPM_",
];

/**
 * The environment the service runs with: the install's, minus what belongs to that terminal
 * session (or a Claude Code session it ran inside). Values XML can't hold are left out.
 */
export function serviceEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SESSION_VARS.has(key)) continue;
    if (SESSION_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !xmlSafe(value)) continue;
    kept[key] = value;
  }
  // `pnpm tenzo` puts the workspace's node_modules/.bin dirs in front of the PATH.
  if (kept.PATH !== undefined) {
    kept.PATH = kept.PATH.split(delimiter)
      .filter((dir) => dir !== "" && !dir.includes(`${sep}node_modules${sep}.bin`))
      .join(delimiter);
  }
  return claudeEnv(kept);
}

export interface LaunchAgent {
  /** The Node binary to run `cli.ts` with: the one installing. */
  node: string;
  /** This checkout's `apps/daemon/src/cli.ts`. */
  cli: string;
  /** Where it runs: the checkout's root. */
  cwd: string;
  env: Record<string, string>;
  /** stdout and stderr, appended: `$TENZO_HOME/daemon.log`. */
  log: string;
}

/**
 * The launchd property list for the daemon. Starts at login (`RunAtLoad`) and is started again
 * whenever it exits with an error or a signal (`KeepAlive`), at most every 10 s; a clean stop
 * (`tenzo service uninstall`, or SIGTERM) leaves it stopped.
 */
export function launchAgentPlist(agent: LaunchAgent): string {
  const env = plistEnvEntries(agent.env);
  const args = [agent.node, agent.cli, "serve"]
    .map((arg) => `      <string>${xml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(agent.cwd)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xml(agent.log)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(agent.log)}</string>
  </dict>
</plist>
`;
}

/**
 * The `EnvironmentVariables` of a plist `launchAgentPlist` wrote, or null when it has none (or
 * isn't one of ours).
 */
export function plistEnv(plist: string): Record<string, string> | null {
  const block = ENV_BLOCK.exec(plist);
  if (!block) return null;
  const env: Record<string, string> = {};
  for (const [, key, value] of (block[2] ?? "").matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    env[unxml(key ?? "")] = unxml(value ?? "");
  }
  return env;
}

/** The same plist with `env` as its environment; everything else as it was. */
export function withPlistEnv(plist: string, env: Record<string, string>): string {
  if (!ENV_BLOCK.test(plist)) {
    throw new TenzoError("The service's plist has no environment to update; run `tenzo service install` again.");
  }
  return plist.replace(ENV_BLOCK, (_, head: string) => `${head}\n${plistEnvEntries(env)}\n    </dict>`);
}

const ENV_BLOCK = /(<key>EnvironmentVariables<\/key>\s*<dict>)([\s\S]*?)\n?\s*<\/dict>/;

function plistEnvEntries(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((key) => `      <key>${xml(key)}</key>\n      <string>${xml(env[key] ?? "")}</string>`)
    .join("\n");
}

function unxml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** XML 1.0 has no way to write most control characters, escaped or not. */
function xmlSafe(text: string): boolean {
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/.test(text);
}

/** The agent for this checkout, Node and environment. */
export function launchAgentFor(config: DaemonConfig, env: NodeJS.ProcessEnv): LaunchAgent {
  const cli = resolve(import.meta.dirname, "cli.ts");
  return {
    node: process.execPath,
    cli,
    cwd: resolve(import.meta.dirname, "../../.."),
    // Paths made absolute: the service doesn't start where the install ran.
    env: {
      ...serviceEnv(env),
      TENZO_HOME: config.home,
      TENZO_WEB_DIR: config.webDir,
      ...(env.TENZO_CLAUDE_PATH ? { TENZO_CLAUDE_PATH: resolve(env.TENZO_CLAUDE_PATH) } : {}),
    },
    log: join(config.home, "daemon.log"),
  };
}

/**
 * What may go wrong later with an install from here: a checkout in a linked git worktree
 * (`.git` is a file there) may be removed with its worktree, and the service would then fail at
 * every start; an install from inside Claude Code takes that session's environment as the user's.
 */
export function installWarnings(env: NodeJS.ProcessEnv, linkedWorktree: boolean): string[] {
  const warnings: string[] = [];
  if (linkedWorktree) {
    warnings.push(
      "Warning: this checkout is a linked git worktree. If it is removed, the service fails at every start; install from the main checkout instead.",
    );
  }
  if (env.CLAUDECODE) {
    warnings.push(
      "Warning: installed from inside Claude Code (CLAUDECODE is set), so the service has that session's environment, not your shell's. Run `tenzo service install` again from your own terminal.",
    );
  }
  return warnings;
}

/** Whether `root` is a linked git worktree rather than a main checkout. */
export function isLinkedWorktree(root: string): boolean {
  try {
    return statSync(join(root, ".git")).isFile();
  } catch {
    return false;
  }
}

// The commands. Only these touch launchd; everything above is pure (or only reads).

function domain(): string {
  return `gui/${userInfo().uid}`;
}

function requireMac(): void {
  if (process.platform !== "darwin") {
    throw new TenzoError(
      "tenzo service uses launchd, so it is macOS only. Elsewhere, run `tenzo serve` under your init system (systemd, say).",
    );
  }
}

function launchctl(...args: string[]): { ok: boolean; output: string } {
  const run = spawnSync("launchctl", args, { encoding: "utf8" });
  return { ok: run.status === 0, output: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
}

export function installService(config: DaemonConfig, env: NodeJS.ProcessEnv): string[] {
  requireMac();
  const agent = launchAgentFor(config, env);
  const path = plistPath();
  ensureHome(config.home); // launchd opens the log there before the daemon runs
  mkdirSync(dirname(path), { recursive: true });
  // Private: the environment may hold credentials (ANTHROPIC_API_KEY, say).
  writeFileSync(path, launchAgentPlist(agent), { mode: 0o600 });
  chmodSync(path, 0o600);
  loadService(path);
  return [
    `Installed ${SERVICE_LABEL}: tenzo serve on 127.0.0.1:${config.port}, at login and after a crash.`,
    `  plist  ${path}`,
    `  log    ${agent.log}`,
    `  runs   ${agent.node} ${agent.cli} serve`,
    "If another tenzo daemon holds this TENZO_HOME, the service retries every 10 s until it stops.",
    ...installWarnings(env, isLinkedWorktree(agent.cwd)),
  ];
}

/** (Re)loads the agent from its plist: stops the running daemon, if any, and starts it again. */
export function loadService(path: string = plistPath()): void {
  requireMac();
  launchctl("bootout", `${domain()}/${SERVICE_LABEL}`); // the one running, if any
  const loaded = launchctl("bootstrap", domain(), path);
  if (!loaded.ok) {
    throw new TenzoError(`launchctl couldn't load ${path}: ${loaded.output || "no reason given"}`);
  }
}

export function uninstallService(): string[] {
  requireMac();
  const path = plistPath();
  const stopped = launchctl("bootout", `${domain()}/${SERVICE_LABEL}`).ok;
  const had = existsSync(path);
  rmSync(path, { force: true });
  if (!stopped && !had) return [`${SERVICE_LABEL} isn't installed.`];
  return [`Uninstalled ${SERVICE_LABEL}${stopped ? " and stopped the daemon" : ""}.`];
}

export function serviceStatus(config: DaemonConfig): string[] {
  requireMac();
  const path = plistPath();
  if (!existsSync(path)) return [`${SERVICE_LABEL} isn't installed. \`tenzo service install\` installs it.`];
  const printed = launchctl("print", `${domain()}/${SERVICE_LABEL}`);
  if (!printed.ok) return [`${SERVICE_LABEL} is installed (${path}) but not loaded.`];
  const field = (name: string) =>
    printed.output.match(new RegExp(`^\\s*${name} = (.+)$`, "m"))?.[1]?.trim();
  const state = field("state") ?? "unknown";
  const pid = field("pid");
  const lastExit = field("last exit code");
  return [
    `${SERVICE_LABEL}: ${state}${pid ? ` (pid ${pid})` : ""}${lastExit ? `, last exit ${lastExit}` : ""}`,
    `  plist  ${path}`,
    `  log    ${join(config.home, "daemon.log")}`,
  ];
}
