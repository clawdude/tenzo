#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import type { Command, CommandResult, QueueItem } from "@tenzo/contracts";
import { answerFromWords } from "./answers.ts";
import { VERSION } from "./app.ts";
import { parseArgs } from "./args.ts";
import { callDaemon } from "./client.ts";
import { readConfig } from "./config.ts";
import { TenzoError } from "./errors.ts";
import { formatEvent, formatItem } from "./format.ts";
import { addProject, listProjects, removeProject } from "./projects.ts";
import { startDaemon } from "./server.ts";
import { openStore, type Store } from "./store.ts";

const USAGE = `tenzo ${VERSION}

Usage:
  tenzo serve                            start the daemon on 127.0.0.1 (TENZO_PORT, default 4780);
                                         it runs the threads' agents
  tenzo project add <path>               register the git repo at <path>
  tenzo project list                     list projects
  tenzo project remove <name|path>       forget a project (its repo and thread history are kept)

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
                                         own words; allow/deny for a permission request
  tenzo --version                        print the version

start, send and answer then show the thread's events until it needs you or goes idle
(--detach: don't wait; --json: events as JSON lines). Arguments after a bare -- are never
options: tenzo thread new app -- --weird title

Environment:
  TENZO_PORT           port to listen on, and where the CLI finds the daemon
  TENZO_HOME           state directory (default ~/.tenzo)
  TENZO_WEB_DIR        built web app to serve (default apps/web/build)
  TENZO_ALLOWED_HOSTS  host names besides localhost that may reach the daemon, comma-separated
                       (e.g. its Tailscale Serve name)
  TENZO_CLAUDE_PATH    the claude binary threads run (default: found on PATH)
  TENZO_DEFAULT_MODEL  the model for threads started without --model (default: Claude's own)
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
            t.branch,
            t.title,
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

async function items(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, ["--json"]);
  const snapshot = await call({ type: "snapshot" });
  if (flags.has("--json")) {
    for (const item of snapshot.items) console.log(JSON.stringify(item));
    return;
  }
  if (snapshot.items.length === 0) {
    console.log("Nothing needs you.");
    return;
  }
  const titles = new Map(snapshot.threads.map((t) => [t.id, t.title]));
  console.log(snapshot.items.map((i) => formatItem(i, titles.get(i.threadId))).join("\n\n"));
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
  say(
    result.delivery === "message"
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
  for (;;) {
    const { thread, events } = await call({ type: "thread.events", threadId, after: seq });
    for (const { seq: s, event, environmentId } of events) {
      console.log(json ? JSON.stringify({ seq: s, environmentId, event }) : formatEvent(event));
      seq = s;
      if (event.type === "user-input.requested" || event.type === "request.opened") asked = true;
      if (event.type === "turn.completed" && event.payload.state === "failed") process.exitCode = 1;
    }
    if (!forever) {
      if (asked && thread.activity === "needs-you") {
        const { items: open } = await call({ type: "snapshot" });
        const mine: QueueItem[] = open.filter((i) => i.threadId === thread.id);
        const say = json ? console.error : console.log;
        say(`\n${thread.title} needs you:\n`);
        say(mine.map((i) => formatItem(i)).join("\n\n"));
        say(`\nAnswer with \`tenzo answer ${mine[0]?.id ?? "<item>"} <choice|text>\`.`);
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
    case "thread":
      return thread(args);
    case "items":
      return items(args);
    case "answer":
      return answer(args);
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
