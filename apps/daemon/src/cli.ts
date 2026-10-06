#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { renderUnicodeCompact } from "uqr";
import {
  type AutomationView,
  type Device,
  pairingUrl,
  type Command,
  type CommandResult,
  isSnoozed,
  type QueueItem,
} from "@tenzo/contracts";
import { answerFromWords, isAsk } from "./answers.ts";
import { scheduledNote } from "./automations.ts";
import { VERSION } from "./app.ts";
import { parseArgs } from "./args.ts";
import { callDaemon } from "./client.ts";
import { readConfig } from "./config.ts";
import { pairingOrigin } from "./devices.ts";
import { TenzoError } from "./errors.ts";
import { formatEvent, formatItem } from "./format.ts";
import { readProjectConfig } from "./project-config.ts";
import { addProject, listProjects, removeProject } from "./projects.ts";
import { startDaemon } from "./server.ts";
import {
  installService,
  loadService,
  plistPath,
  serviceStatus,
  uninstallService,
  writePlist,
} from "./service.ts";
import { openStore, type Store } from "./store.ts";
import { systemTailscale } from "./tailscale.ts";
import { servicePorts, setUpTailscale } from "./tailscale-setup.ts";

const USAGE = `tenzo ${VERSION}

Usage:
  tenzo serve                            start the daemon on 127.0.0.1 (TENZO_PORT, default 4780);
                                         it runs the threads' agents
  tenzo project add <path>               register the git repo at <path>
  tenzo project list                     list projects
  tenzo project remove <name|path>       forget a project (its repo and thread history are kept)
  tenzo service install                  macOS: run the daemon as a launchd agent, at login and
                                         after a crash, with this shell's environment
  tenzo service uninstall                stop it and remove the agent
  tenzo service status                   whether it is installed and running

  Thread commands talk to the running daemon:
  tenzo thread start <project> <prompt…> new thread, and Claude Code starts on the prompt in its
                                         worktree (--model <name>)
  tenzo thread send <id> <prompt…>       another prompt; waits its turn if one is running
  tenzo thread new <project> <title…>    new thread (worktree on tenzo/<slug>) without a prompt
  tenzo thread log <id> [--follow]       the thread's events so far (--follow: and as they come)
  tenzo thread list [<project>] [--all]  list active threads (--all: archived too)
  tenzo thread archive <id> [--force]    stop its agent, remove its worktree, keep its branch
                                         (--force: discard uncommitted work, or forget a
                                         thread whose repo was moved or deleted)
  tenzo items                            what the threads need from you, oldest first
  tenzo answer <item> <choice|text…>     answer an item: an option's number or label, or your
                                         own words; allow/deny for a permission request;
                                         build, or what to change, for a proposal;
                                         retry, archive, or what to tell it, for an error;
                                         merge, pr, done, or what needs changing, for
                                         finished work; merge, or what first, for a ready PR
  tenzo automation list [<project>]      the automations the projects' .tenzo/config.json define:
                                         schedule, next run, last run
  tenzo automation run <project> <name>  run one now (a thread, origin automation)
  tenzo automation pause | resume        the off switch, kept in TENZO_HOME: while paused, no
                                         schedule starts a run (running one by hand still works)
  tenzo automation archive <project> <name>
                                         archive its finished runs with a clean worktree
                                         (branches kept); runs going or waiting on you stay
  tenzo pair [--name <name>]             a one-time link and QR code that pairs a phone (or any
                                         browser elsewhere) with this daemon: open it there within
                                         10 minutes (--url <origin>: where the device reaches
                                         Tenzo, default the daemon's TENZO_PUBLIC_URL)
  tenzo pair --tailscale [--name <name>] the same over Tailscale Serve, set up first if need be:
                                         adds the HTTPS routes for the Pass (8443) and live apps
                                         (8444) after asking, leaves other routes alone, and sets
                                         the service's TENZO_* to match (--yes: don't ask;
                                         --https-port, --live-https-port: other ports). See
                                         docs/REMOTE.md
  tenzo devices                          the paired devices: name, when paired, last seen
  tenzo devices rename <id> <name…>      call a device something else
  tenzo devices revoke <id>              unpair it: its token stops working, its connections close
  tenzo --version                        print the version

start, send and answer then show the thread's events until it needs you or goes idle
(--detach: don't wait; --json: events as JSON lines). Arguments after a bare -- are never
options: tenzo thread new app -- --weird title

Environment (details: docs/ARCHITECTURE.md §16):
  TENZO_PORT           port to listen on, and where the CLI finds the daemon (default 4780)
  TENZO_LIVE_PORT      port of the live listener for threads' live apps (default TENZO_PORT + 1)
  TENZO_LIVE_ORIGIN    the live listener's public origins, comma-separated
  TENZO_HOME           state directory (default ~/.tenzo)
  TENZO_WEB_DIR        built web app to serve (default apps/web/build)
  TENZO_ALLOWED_HOSTS  host names besides localhost that may reach the daemon, comma-separated
                       (e.g. its Tailscale Serve name)
  TENZO_PUBLIC_URL     where devices elsewhere reach Tenzo, port included, for tenzo pair's link
  TENZO_DEV_ORIGIN     dev-server origins whose pages may use the API (pnpm dev sets Vite's)
  TENZO_CLAUDE_PATH    the claude binary threads run (default: found on PATH)
  TENZO_DEFAULT_MODEL  the model for threads started without --model (default: Claude's own)
  TENZO_SNOOZE_MS      how long a swipe snoozes an item, in ms (default 15 minutes)
  TENZO_PUSH_PREVIEW   what a notification says: short (default) or none
  TENZO_PUSH_CONTACT   the mailto: or https: contact push services see
`;

const config = () => readConfig(process.env);

async function serve(): Promise<void> {
  const daemon = await startDaemon(config());
  console.log(`tenzo ${VERSION} · ${daemon.environmentId} · listening on ${daemon.url}`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) process.exit(1); // second signal: don't wait
    stopping = true;
    console.log(`\n${signal}: stopping`);
    daemon.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

function call<C extends Command>(command: C): Promise<CommandResult<C["type"]>> {
  return callDaemon(config(), command);
}

/** Opens the store for one command and closes it afterwards. */
async function withStore<T>(fn: (store: Store) => Promise<T> | T): Promise<T> {
  const store = openStore(config().home);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

function usageError(message: string): never {
  throw new TenzoError(`${message}\n\n${USAGE}`);
}

async function project([sub, ...rest]: string[]): Promise<void> {
  const args = parseArgs(rest).positional;
  switch (sub) {
    case "add": {
      const [path] = args;
      if (!path) usageError("tenzo project add needs a path.");
      const p = await withStore((store) => addProject(store, path));
      console.log(`Added "${p.name}": ${p.path} (default branch ${p.defaultBranch})`);
      // Its automations start by themselves once the daemon sees it: say so now.
      const note = scheduledNote(readProjectConfig(p.path));
      if (note) console.log(note);
      return;
    }
    case "list":
    case "ls": {
      const projects = await withStore(listProjects);
      if (projects.length === 0)
        console.log("No projects yet. Add one with `tenzo project add <path>`.");
      else printTable(projects.map((p) => [p.name, p.defaultBranch, p.path]));
      return;
    }
    case "remove":
    case "rm": {
      const [ref] = args;
      if (!ref) usageError("tenzo project remove needs a project name or path.");
      const p = await withStore((store) => removeProject(store, ref));
      console.log(`Removed "${p.name}". ${p.path} is untouched.`);
      return;
    }
    default:
      usageError(`Unknown project command "${sub ?? ""}".`);
  }
}

function service([sub, ...rest]: string[]): void {
  parseArgs(rest); // no options
  const lines =
    sub === "install"
      ? installService(config(), process.env)
      : sub === "uninstall"
        ? uninstallService()
        : sub === "status"
          ? serviceStatus(config())
          : usageError(`Unknown service command "${sub ?? ""}".`);
  for (const line of lines) console.log(line);
}

async function thread([sub, ...rest]: string[]): Promise<void> {
  const flagsFor: Record<string, string[]> = {
    start: ["--json", "--detach"],
    send: ["--json", "--detach"],
    log: ["--json", "--follow"],
    list: ["--all"],
    ls: ["--all"],
    archive: ["--force"],
  };
  const { flags, options, positional } = parseArgs(
    rest,
    flagsFor[sub ?? ""] ?? [],
    sub === "start" ? ["--model"] : [],
  );
  const json = flags.has("--json");
  // With --json, stdout is events only.
  const say = json ? console.error : console.log;
  switch (sub) {
    case "start": {
      const [projectRef, ...words] = positional;
      const prompt = words.join(" ").trim();
      if (!projectRef || prompt === "") {
        usageError("tenzo thread start needs a project and a prompt.");
      }
      const model = options.get("--model");
      const { thread: t } = await call({
        type: "thread.create",
        project: projectRef,
        prompt,
        ...(model ? { model } : {}),
      });
      say(`Created ${t.id} on ${t.branch}\n${t.worktreePath}`);
      if (!flags.has("--detach")) await follow(t.id, 0, json);
      return;
    }
    case "send": {
      const [id, ...words] = positional;
      const prompt = words.join(" ").trim();
      if (!id || prompt === "") usageError("tenzo thread send needs a thread id and a prompt.");
      const { thread: t } = await call({ type: "thread.send", threadId: id, prompt });
      if (t.queued > 0 && t.working) say(`Queued: ${t.id} is busy; your prompt goes next.`);
      if (!flags.has("--detach")) await follow(t.id, t.lastSeq, json);
      return;
    }
    case "new": {
      const [projectRef, ...words] = positional;
      if (!projectRef || words.length === 0)
        usageError("tenzo thread new needs a project and a title.");
      const { thread: t } = await call({
        type: "thread.create",
        project: projectRef,
        title: words.join(" "),
      });
      console.log(`Created ${t.id} on ${t.branch}\n${t.worktreePath}`);
      return;
    }
    case "log": {
      const [id] = positional;
      if (!id) usageError("tenzo thread log needs a thread id.");
      if (flags.has("--follow")) await follow(id, 0, json, { forever: true });
      else {
        const { events } = await call({ type: "thread.events", threadId: id });
        for (const e of events) console.log(json ? JSON.stringify(e) : formatEvent(e.event));
      }
      return;
    }
    case "list":
    case "ls": {
      const [projectRef] = positional;
      const { threads } = await call({
        type: "thread.list",
        ...(projectRef ? { project: projectRef } : {}),
        includeArchived: flags.has("--all"),
      });
      if (threads.length === 0) console.log("No threads.");
      else
        printTable(
          threads.map((t) => [
            t.id,
            t.projectName,
            t.status === "archived" ? "archived" : t.activity,
            t.phase,
            t.branch,
            t.origin === "automation" ? `${t.title} (automation: ${t.automation ?? "?"})` : t.title,
          ]),
        );
      return;
    }
    case "archive": {
      const [id] = positional;
      if (!id) usageError("tenzo thread archive needs a thread id.");
      const { thread: t } = await call({
        type: "thread.archive",
        threadId: id,
        force: flags.has("--force"),
      });
      console.log(`Archived ${t.id}. Worktree removed; branch ${t.branch} kept.`);
      return;
    }
    default:
      usageError(`Unknown thread command "${sub ?? ""}".`);
  }
}

async function automation([sub, ...rest]: string[]): Promise<void> {
  const { flags, positional } = parseArgs(rest, sub === "list" || sub === "ls" ? ["--json"] : []);
  switch (sub) {
    case "list":
    case "ls": {
      const [projectRef] = positional;
      const { automations, paused, problems } = await call({
        type: "automation.list",
        ...(projectRef ? { project: projectRef } : {}),
      });
      if (flags.has("--json")) {
        for (const a of automations) console.log(JSON.stringify(a));
        return;
      }
      if (paused) console.log("Automations are paused: no schedule starts a run (`tenzo automation resume`).\n");
      // A config that can't be read runs none of its automations: say why, not "none".
      for (const p of problems) {
        console.log(`${p.projectName}: its Tenzo config is invalid, so its automations don't run: ${p.problem}`);
      }
      if (automations.length === 0) {
        if (problems.length === 0) {
          console.log("No automations. A project defines them under `automations` in .tenzo/config.json.");
        }
        return;
      }
      if (problems.length > 0) console.log("");
      printTable(automations.map((a) => [a.projectName, a.name, scheduleCell(a), lastRunCell(a)]));
      return;
    }
    case "pause":
    case "resume": {
      const { paused } = await call({ type: "automation.pause", paused: sub === "pause" });
      console.log(
        paused
          ? "Automations paused: no schedule starts a run until `tenzo automation resume` (running one by hand still works)."
          : "Automations resumed: schedules start runs again.",
      );
      return;
    }
    case "run": {
      const [projectRef, name] = positional;
      if (!projectRef || !name) usageError("tenzo automation run needs a project and an automation's name.");
      const { automation: a, run, thread: t } = await call({
        type: "automation.run",
        project: projectRef,
        name,
      });
      if (run.result === "started" && t) {
        console.log(`Started ${t.id}: "${t.title}" on ${t.branch}\n${t.worktreePath}`);
      } else {
        console.log(`${run.result === "skipped" ? "Skipped" : "Couldn't start it"}: ${run.reason ?? ""}`);
        if (run.result === "failed") process.exitCode = 1;
      }
      if (a.schedule && a.enabled && a.nextRunAt) {
        console.log(`Its schedule (${a.schedule}) is on: next run ${localTime(a.nextRunAt)}.`);
      }
      return;
    }
    case "archive": {
      const [projectRef, name] = positional;
      if (!projectRef || !name) usageError("tenzo automation archive needs a project and an automation's name.");
      const { archived, kept } = await call({ type: "automation.archiveFinished", project: projectRef, name });
      console.log(
        archived.length === 0
          ? "No finished runs to archive."
          : `Archived ${archived.length} finished run${archived.length === 1 ? "" : "s"}; their branches are kept.`,
      );
      for (const k of kept) console.log(`Kept ${k.threadId}: ${k.reason}`);
      return;
    }
    default:
      usageError(`Unknown automation command "${sub ?? ""}".`);
  }
}

async function pair(args: string[]): Promise<void> {
  // Raw TCP through Serve makes every client local, unpaired (README, docs/REMOTE.md).
  for (const tcp of ["--tcp", "--tls-terminated-tcp"]) {
    if (args.some((a) => a === tcp || a.startsWith(`${tcp}=`))) {
      throw new TenzoError(
        `Tenzo never uses Tailscale Serve's ${tcp}: through raw TCP every client looks like this Mac itself, with no pairing at all. \`tenzo pair --tailscale\` sets up HTTPS routes.`,
      );
    }
  }
  const { flags, options } = parseArgs(
    args,
    ["--tailscale", "--yes"],
    ["--name", "--url", "--https-port", "--live-https-port"],
  );
  const name = options.get("--name");
  if (flags.has("--tailscale")) {
    if (options.has("--url")) usageError("--url and --tailscale don't go together: --tailscale finds the URL.");
    return pairTailscale(name, {
      yes: flags.has("--yes"),
      httpsPort: portOption(options, "--https-port"),
      liveHttpsPort: portOption(options, "--live-https-port"),
    });
  }
  for (const only of ["--yes", "--https-port", "--live-https-port"]) {
    if (flags.has(only) || options.has(only)) usageError(`${only} goes with --tailscale.`);
  }
  const flag = options.get("--url");
  if (flag !== undefined) pairingOrigin(null, flag); // a bad --url fails before a code is made
  const paired = await call({ type: "device.pair", ...(name ? { name } : {}) });
  printPairing(pairingOrigin(paired.origin, flag), paired, name);
}

function portOption(options: Map<string, string>, name: string): number | undefined {
  const raw = options.get(name);
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TenzoError(`${name} takes a port number, like 8443; got "${raw}".`);
  }
  return port;
}

async function pairTailscale(
  name: string | undefined,
  options: { yes: boolean; httpsPort: number | undefined; liveHttpsPort: number | undefined },
): Promise<void> {
  const path = plistPath();
  const service =
    process.platform === "darwin" && existsSync(path)
      ? {
          path,
          read: () => readFileSync(path, "utf8"),
          write: (plist: string) => writePlist(path, plist),
          reload: () => loadService(path),
        }
      : null;
  // The service's daemon listens where its plist says, whatever this shell's TENZO_PORT is.
  const cfg = config();
  const { port, livePort } = service
    ? servicePorts(service.read())
    : { port: cfg.port, livePort: cfg.livePort ?? cfg.port + 1 };
  const daemon = { host: cfg.host, port };
  const answers = () =>
    fetch(`http://${daemon.host}:${daemon.port}/health`, { signal: AbortSignal.timeout(1_000) }).then(
      (r) => r.ok,
      () => false,
    );
  const done = await setUpTailscale(
    {
      tailscale: systemTailscale(),
      daemonPort: port,
      livePort,
      settings: async () => ((await answers()) ? callDaemon(daemon, { type: "daemon.settings" }) : null),
      pair: () => callDaemon(daemon, { type: "device.pair", ...(name ? { name } : {}) }),
      waitForDaemon: async () => {
        for (let i = 0; i < 60; i++) {
          if (await answers()) return true;
          await sleep(500);
        }
        return false;
      },
      service,
      env: process.env,
      confirm: ask,
      say: (line) => console.log(line),
    },
    options,
  );
  if (!done) {
    process.exitCode = 1;
    return;
  }
  console.log("");
  printPairing(done.origin, done.paired, name);
}

/** A yes/no question on the terminal; without one, say how to go on. */
async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new TenzoError(`${question.trim()} There's no terminal to ask on: run it again with --yes to go ahead.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printPairing(origin: string, paired: { code: string; expiresAt: string }, name: string | undefined): void {
  const { code, expiresAt } = paired;
  const url = pairingUrl(origin, code);
  console.log(`Open this on the device you want to pair${name ? ` (${name})` : ""}:\n`);
  console.log(`  ${url}\n`);
  console.log(renderUnicodeCompact(url, { border: 2 }));
  console.log(
    `\nScan it with the phone's camera. It works once, until ${localTime(expiresAt)}; the browser that opens it gets its own token and lands on the Pass.`,
  );
  console.log("`tenzo devices` lists paired devices; `tenzo devices revoke <id>` unpairs one.");
}

async function devices([sub, ...rest]: string[]): Promise<void> {
  const { positional } = parseArgs(rest);
  switch (sub) {
    case undefined:
    case "list":
    case "ls": {
      const { devices: list } = await call({ type: "device.list" });
      if (list.length === 0) {
        console.log("No paired devices. Pair one with `tenzo pair`.");
        return;
      }
      printTable([
        ["ID", "NAME", "PAIRED", "LAST SEEN"],
        ...list.map((d: Device) => [d.id, d.name, localTime(d.createdAt), d.lastSeenAt ? localTime(d.lastSeenAt) : "never"]),
      ]);
      return;
    }
    case "rename": {
      const [id, ...words] = positional;
      const name = words.join(" ").trim();
      if (!id || name === "") usageError("tenzo devices rename needs a device id and a name.");
      const { device } = await call({ type: "device.rename", deviceId: id, name });
      console.log(`Renamed ${device.id} to "${device.name}".`);
      return;
    }
    case "revoke":
    case "rm": {
      const [id] = positional;
      if (!id) usageError("tenzo devices revoke needs a device id (`tenzo devices` lists them).");
      const { device } = await call({ type: "device.revoke", deviceId: id });
      console.log(`Revoked "${device.name}" (${device.id}): it is disconnected and needs \`tenzo pair\` to come back.`);
      return;
    }
    default:
      usageError(`Unknown devices command "${sub}".`);
  }
}

function scheduleCell(a: AutomationView): string {
  if (!a.schedule) return "run by hand";
  if (!a.enabled) return `${a.schedule} (switched off)`;
  return `${a.schedule}${a.nextRunAt ? `, next ${localTime(a.nextRunAt)}` : ""}`;
}

function lastRunCell(a: AutomationView): string {
  const run = a.lastRun;
  if (!run) return "never ran";
  const what =
    run.result === "started" ? `${run.state ?? "started"} ${run.threadId ?? ""}` : `${run.result}: ${run.reason ?? ""}`;
  const cost = run.costUsd === null ? "" : ` · $${run.costUsd.toFixed(2)}`;
  return `last ${localTime(run.at)} ${what}${cost}`;
}

function localTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

async function items(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, ["--json"]);
  const snapshot = await call({ type: "snapshot" });
  if (flags.has("--json")) {
    for (const item of snapshot.items) console.log(JSON.stringify(item));
    return;
  }
  const titles = new Map(snapshot.threads.map((t) => [t.id, t.title]));
  const now = snapshot.items.filter((i) => !isSnoozed(i));
  const later = snapshot.items.filter((i) => isSnoozed(i));
  console.log(
    now.length === 0
      ? "Nothing needs you."
      : now.map((i) => formatItem(i, titles.get(i.threadId))).join("\n\n"),
  );
  if (later.length > 0) {
    console.log(`\nSnoozed (back by themselves; \`tenzo answer\` still takes them):\n`);
    console.log(later.map((i) => formatItem(i, titles.get(i.threadId))).join("\n\n"));
  }
}

async function answer(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args, ["--json", "--detach"]);
  const [itemId, ...words] = positional;
  if (!itemId || words.length === 0) usageError("tenzo answer needs an item and an answer.");
  const json = flags.has("--json");
  const say = json ? console.error : console.log;
  const snapshot = await call({ type: "snapshot" });
  const item = snapshot.items.find((i) => i.id === itemId);
  if (!item) {
    throw new TenzoError(`No open item "${itemId}". \`tenzo items\` lists the open ones.`);
  }
  const result = await call({
    type: "item.answer",
    itemId: item.id,
    answer: answerFromWords(item, words),
  });
  if (result.delivery === "archived") {
    say(`Archived ${result.thread.id}. Worktree removed; branch ${result.thread.branch} kept.`);
    return;
  }
  say(
    result.delivery === "message" &&
      (item.kind === "error" || item.kind === "finished" || item.kind === "ready")
      ? `Answered ${item.id}; it goes to the agent as its next turn.`
      : result.delivery === "message"
      ? `Answered ${item.id}. Its agent had stopped; resuming it with your answer.`
      : result.item.status === "open"
        ? `Sent your answer to ${item.id}, but the agent hasn't confirmed it; \`tenzo items\` shows whether it is still open.`
        : `Answered ${item.id}.`,
  );
  if (!flags.has("--detach")) await follow(item.threadId, result.thread.lastSeq, json);
}

/**
 * Prints a thread's events from `after` as they arrive, until it needs you (then shows what it
 * asks) or has nothing left to do. With `forever`, until Ctrl-C.
 */
async function follow(
  threadId: string,
  after: number,
  json: boolean,
  { forever = false } = {},
): Promise<void> {
  let seq = after;
  let asked = false;
  let failed = false;
  for (;;) {
    const { thread, events } = await call({ type: "thread.events", threadId, after: seq });
    for (const { seq: s, event, environmentId } of events) {
      console.log(json ? JSON.stringify({ seq: s, environmentId, event }) : formatEvent(event));
      seq = s;
      if (isAsk(event) || event.type === "report.submitted" || event.type === "merge.ready") {
        asked = true;
      }
      // A failed turn, a crash or an agent that can't start: each leaves an error card.
      if (
        (event.type === "turn.completed" && event.payload.state === "failed") ||
        (event.type === "session.exited" && event.payload.exitKind === "error") ||
        event.type === "runtime.error"
      ) {
        failed = true;
        process.exitCode = 1;
      }
    }
    if (!forever) {
      // Asked something, or stopped on an error: show what it needs (an error card waits as an
      // item too). Anything else needing you is shown once it has stopped working.
      if (thread.activity === "needs-you" && (asked || failed || !thread.working)) {
        const { items: open } = await call({ type: "snapshot" });
        const mine: QueueItem[] = open.filter((i) => i.threadId === thread.id && !isSnoozed(i));
        const say = json ? console.error : console.log;
        say(`\n${thread.title} needs you:\n`);
        say(mine.map((i) => formatItem(i)).join("\n\n"));
        const how =
          mine[0]?.error?.cause === "budget"
            ? "continue|stop|text"
            : mine[0]?.kind === "error"
              ? "retry|archive|text"
              : "choice|text";
        say(`\nAnswer with \`tenzo answer ${mine[0]?.id ?? "<item>"} <${how}>\`.`);
        return;
      }
      if (!thread.working) return;
    }
    await sleep(250);
  }
}

function printTable(rows: string[][]): void {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0))) ?? [];
  for (const row of rows) {
    console.log(
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  "),
    );
  }
}

async function main([command, ...args]: string[]): Promise<void> {
  switch (command) {
    case "serve":
      return serve();
    case "project":
      return project(args);
    case "service":
      return service(args);
    case "thread":
      return thread(args);
    case "items":
      return items(args);
    case "automation":
    case "automations":
      return automation(args);
    case "answer":
      return answer(args);
    case "pair":
      return pair(args);
    case "devices":
    case "device":
      return devices(args);
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      process.exit(2);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof TenzoError)) throw error;
  console.error(`tenzo: ${error.message}`);
  process.exit(1);
}
