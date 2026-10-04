#!/usr/bin/env node
/**
 * Tenzo's feature-parity check (docs/PARITY.md): one real Claude Code thread, run by a scratch
 * `tenzo serve` and driven through the real `tenzo` CLI, in a scratch copy of
 * `tools/parity/fixture`, then a PASS/FAIL table for the subagent, the skill, the hook and the
 * MCP server. Uses your `claude` and your login; never touches ~/.tenzo, a running daemon's
 * port, or any repo of yours.
 *
 *   pnpm parity [--model <name>] [--keep]
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { RuntimeEvent } from "@tenzo/contracts";
import {
  answerFor,
  checkParity,
  FIXTURE,
  formatTable,
  parityPrompt,
  parseHookLog,
} from "./checks.ts";
import { copyFixture } from "./fixture.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CLI = join(REPO_ROOT, "apps/daemon/src/cli.ts");
/** A run takes well under a minute on haiku; past this something is stuck. */
const TIMEOUT_MS = 5 * 60_000;

function usage(): never {
  console.error("Usage: pnpm parity [--model <name>] [--keep]");
  process.exit(2);
}

function parseCli(args: string[]): { model: string; keep: boolean } {
  let model = "haiku";
  let keep = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--keep") keep = true;
    else if (arg === "--model") model = args[++i] ?? usage();
    else if (arg?.startsWith("--model=")) model = arg.slice("--model=".length);
    else if (arg === "--")
      continue; // pnpm passes it through
    else usage();
  }
  return { model, keep };
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.stderr}${result.stdout}`,
    );
  }
  return result.stdout;
}

/** A scratch git repo holding the fixture under its live names, committed on `main`. */
function makeProject(root: string): string {
  const repo = join(root, "parity-project");
  copyFixture(repo);
  const git = (...args: string[]) => run("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git(
    "-c",
    "user.name=Tenzo parity",
    "-c",
    "user.email=parity@tenzo.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "Parity fixture",
  );
  return repo;
}

/** One line of progress per tool call and message, so a slow run shows where it is. */
function progress(event: RuntimeEvent): string | undefined {
  switch (event.type) {
    case "session.configured":
      return `  session  ${event.payload.model} · Claude Code ${event.payload.agentVersion}`;
    case "item.started":
      return event.payload.itemType === "tool" ? `  →  ${event.payload.text ?? ""}` : undefined;
    case "item.completed": {
      const p = event.payload;
      if (p.itemType === "tool") return `  ${p.status === "failed" ? "✗" : "✓"}  ${p.toolName}`;
      if (p.itemType === "assistant_message") {
        const text = (p.text ?? "").replaceAll(/\s+/g, " ").trim();
        const who = p.parentItemId ? "↳ subagent" : "claude";
        return `  ${who}: ${text.length > 140 ? `${text.slice(0, 139)}…` : text}`;
      }
      return undefined;
    }
    case "request.opened":
      return `  !  asks permission: ${event.payload.detail}`;
    case "user-input.requested":
      return "  !  asks a question";
    case "proposal.requested":
      return `  !  proposes: ${event.payload.headline}`;
    case "runtime.error":
      return `  !  ${event.payload.message}`;
    case "turn.completed":
      return `  turn ${event.payload.state}`;
    default:
      return undefined;
  }
}

/** A port nobody listens on right now, for the scratch daemon. */
function freePort(): Promise<number> {
  return new Promise((done, failed) => {
    const server = createServer();
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });
}

/** `tenzo serve` on the scratch home and port; its output goes to `log`. */
async function startDaemon(env: NodeJS.ProcessEnv, port: number, log: string[]) {
  const child = spawn(process.execPath, [CLI, "serve"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8").on("data", (chunk: string) => log.push(chunk));
  }
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM"); // stops the thread's claude cleanly
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    await exited;
    clearTimeout(timer);
  };
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`tenzo serve exited:\n${log.join("")}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { stop };
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`tenzo serve didn't come up on port ${port}:\n${log.join("")}`);
    }
    await sleep(100);
  }
}

/** One command to the scratch daemon's API, as the CLI and the web app send them. */
async function command<T>(port: number, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}/api/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reply = (await response.json()) as { ok: boolean; result?: T; error?: string };
  if (!reply.ok) throw new Error(`${String(body.type)}: ${reply.error}`);
  return reply.result as T;
}

/**
 * Starts the thread through the daemon and follows its events until its first turn completes,
 * answering its items with `tenzo answer` the way you would; answerFor decides what to say.
 */
async function runThread(
  repo: string,
  prompt: string,
  model: string,
  env: NodeJS.ProcessEnv,
  port: number,
  stderr: string[],
): Promise<RuntimeEvent[]> {
  const created = run(
    process.execPath,
    [CLI, "thread", "start", repo, "--model", model, "--detach", "--", prompt],
    { cwd: REPO_ROOT, env },
  );
  const threadId = /Created (thr_[a-z0-9]+)/.exec(created)?.[1];
  if (!threadId) throw new Error(`tenzo thread start said:\n${created}`);

  const events: RuntimeEvent[] = [];
  let after = 0;
  let turnId: string | undefined;
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const page = await command<{ events: { seq: number; event: RuntimeEvent }[] }>(port, {
      type: "thread.events",
      threadId,
      after,
    });
    for (const { seq, event } of page.events) {
      after = seq;
      events.push(event);
      const line = progress(event);
      if (line) console.error(line);
      if (event.type === "turn.started" && turnId === undefined) turnId = event.turnId;
      if (event.type === "turn.completed" && event.turnId === turnId) return events;
      const answer = answerFor(event);
      if (answer === null) return events; // a question: nobody to answer it, the check fails
      if (answer !== undefined && "requestId" in event) {
        const item = `itm_${event.requestId.slice("req_".length)}`;
        console.error(`  ←  ${answer}`);
        const reply = answer === "y" ? ["allow"] : ["--", answer];
        const result = spawnSync(
          process.execPath,
          [CLI, "answer", item, "--detach", ...reply],
          { cwd: REPO_ROOT, env, encoding: "utf8" },
        );
        stderr.push(result.stdout, result.stderr);
        if (result.status !== 0) throw new Error(`tenzo answer failed:\n${result.stderr}`);
      }
    }
    if (Date.now() > deadline) {
      stderr.push(`\nGave up after ${TIMEOUT_MS / 1000}s without the turn completing.\n`);
      return events;
    }
    await sleep(250);
  }
}

async function main(): Promise<void> {
  const { model, keep } = parseCli(process.argv.slice(2));
  const root = mkdtempSync(join(tmpdir(), "tenzo-parity-"));
  let passed = false;
  try {
    passed = await check(root, model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\nFAIL: the check couldn't run.\n${message}`);
  } finally {
    if (passed && !keep) {
      rmSync(root, { recursive: true, force: true });
    } else {
      console.log(
        `\nKept ${root}: events.jsonl, tenzo.stderr, the repo and its thread's worktree.`,
      );
    }
  }
  process.exitCode = passed ? 0 : 1;
}

/** One run in `root`: prints the table and says whether every check passed. */
async function check(root: string, model: string): Promise<boolean> {
  // Only Tenzo's state and port are redirected; Claude runs with your own config, as in a real
  // thread. The daemon gets a free port, never the default one a real daemon may be using.
  const port = await freePort();
  const env = { ...process.env, TENZO_HOME: join(root, "home"), TENZO_PORT: String(port) };
  const word = randomBytes(4).toString("hex");

  console.error(`Parity check in ${root} (model ${model}, daemon on port ${port})`);
  const repo = makeProject(root);
  run(process.execPath, [CLI, "project", "add", repo], { cwd: REPO_ROOT, env });
  const stderr: string[] = [];
  const daemon = await startDaemon(env, port, stderr);
  let events: RuntimeEvent[] = [];
  try {
    events = await runThread(repo, parityPrompt(word), model, env, port, stderr);
  } finally {
    await daemon.stop();
    writeFileSync(join(root, "events.jsonl"), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
    writeFileSync(join(root, "tenzo.stderr"), stderr.join(""));
  }
  const code = events.length === 0 ? "no events" : "ok";
  const worktree = events.find((e) => e.type === "session.configured")?.payload.cwd;
  const hookLog = worktree ? join(worktree, FIXTURE.hookLog) : undefined;
  const hooks = parseHookLog(hookLog && existsSync(hookLog) ? readFileSync(hookLog, "utf8") : null);
  const checks = checkParity(events, hooks, word);

  console.log(`\n${formatTable(checks)}`);
  if (events.length === 0) {
    console.log(`\nThe thread reported no events (${code}):\n${stderr.join("").trim()}`);
  }
  return checks.every((c) => c.pass);
}

await main();
