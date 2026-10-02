#!/usr/bin/env node
import { VERSION } from "./app.ts";
import { readConfig } from "./config.ts";
import { parseArgs } from "./args.ts";
import { TenzoError } from "./errors.ts";
import { addProject, findProject, listProjects, removeProject } from "./projects.ts";
import { startDaemon } from "./server.ts";
import { openStore, type Store } from "./store.ts";
import { archiveThread, createThread, listThreads, type Thread } from "./threads.ts";

const USAGE = `tenzo ${VERSION}

Usage:
  tenzo serve                            start the daemon on 127.0.0.1 (TENZO_PORT, default 4780)
  tenzo project add <path>               register the git repo at <path>
  tenzo project list                     list projects
  tenzo project remove <name|path>       forget a project (its repo is left alone)
  tenzo thread new <project> <title…>    new worktree on branch tenzo/<slug> from the default branch
  tenzo thread list [<project>] [--all]  list active threads (--all: archived too)
  tenzo thread archive <id> [--force]    remove the thread's worktree, keep its branch
                                         (--force: discard uncommitted work, or forget a
                                         thread whose repo was moved or deleted)
  tenzo --version                        print the version

Arguments after a bare -- are never options: tenzo thread new app -- --weird title

Environment:
  TENZO_PORT     port to listen on
  TENZO_HOME     state directory (default ~/.tenzo)
  TENZO_WEB_DIR  built web app to serve (default apps/web/build)
`;

async function serve(): Promise<void> {
  const config = readConfig(process.env);
  const daemon = await startDaemon(config);
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

/** Opens the store for one command and closes it afterwards. */
async function withStore<T>(fn: (store: Store) => Promise<T> | T): Promise<T> {
  const store = openStore(readConfig(process.env).home);
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
  const allowed = sub === "list" || sub === "ls" ? ["--all"] : sub === "archive" ? ["--force"] : [];
  const { flags, positional } = parseArgs(rest, allowed);
  switch (sub) {
    case "new": {
      const [projectRef, ...words] = positional;
      if (!projectRef || words.length === 0)
        usageError("tenzo thread new needs a project and a title.");
      const t = await withStore((store) => createThread(store, projectRef, words.join(" ")));
      console.log(`Created ${t.id} on ${t.branch}\n${t.worktreePath}`);
      return;
    }
    case "list":
    case "ls": {
      const [projectRef] = positional;
      const rows = await withStore((store) => {
        const names = new Map(listProjects(store).map((p) => [p.id, p.name]));
        const projectId = projectRef ? findProject(store, projectRef).id : undefined;
        const threads = listThreads(store, {
          ...(projectId ? { projectId } : {}),
          includeArchived: flags.has("--all"),
        });
        return threads.map((t: Thread) => [
          t.id,
          names.get(t.projectId) ?? "?",
          t.status,
          t.branch,
          t.worktreePath,
        ]);
      });
      if (rows.length === 0) console.log("No threads.");
      else printTable(rows);
      return;
    }
    case "archive": {
      const [id] = positional;
      if (!id) usageError("tenzo thread archive needs a thread id.");
      const t = await withStore((store) =>
        archiveThread(store, id, { force: flags.has("--force") }),
      );
      console.log(`Archived ${t.id}. Worktree removed; branch ${t.branch} kept.`);
      return;
    }
    default:
      usageError(`Unknown thread command "${sub ?? ""}".`);
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
