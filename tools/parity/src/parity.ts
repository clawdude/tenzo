#!/usr/bin/env node
/**
 * Tenzo's feature-parity check (docs/PARITY.md): one real Claude Code thread, through the real
 * `tenzo` CLI, in a scratch copy of `tools/parity/fixture`, then a PASS/FAIL table for the
 * subagent, the skill, the hook and the MCP server. Uses your `claude` and your login; never
 * touches ~/.tenzo or any repo of yours.
 *
 *   pnpm parity [--model <name>] [--keep]
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeEvent } from "@tenzo/contracts";
import {
  answerFor,
  checkParity,
  FIXTURE,
  formatTable,
  parityPrompt,
  parseEvents,
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
    case "runtime.error":
      return `  !  ${event.payload.message}`;
    case "turn.completed":
      return `  turn ${event.payload.state}`;
    default:
      return undefined;
  }
}

/** `tenzo thread start --json`, streaming progress; resolves with stdout once it exits. */
function startThread(repo: string, prompt: string, model: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((done, failed) => {
    // tenzo asks its prompts on stdin, as it would ask you; answerFor decides what to type.
    const child = spawn(
      process.execPath,
      [CLI, "thread", "start", repo, "--model", model, "--json", "--", prompt],
      { cwd: REPO_ROOT, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let partial = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const event of parseEvents(lines.join("\n"))) {
        const line = progress(event);
        if (line) console.error(line);
        const answer = answerFor(event);
        if (answer === null || event.type === "turn.completed") child.stdin.end();
        else if (answer !== undefined && child.stdin.writable) {
          console.error(`  ←  ${answer}`);
          child.stdin.write(`${answer}\n`);
        }
      }
    });
    child.stdin.on("error", () => {}); // tenzo exited first: nothing left to answer
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    // Ctrl-C twice is how tenzo stops a session cleanly; the kill is the last resort.
    const timers = [
      setTimeout(() => child.kill("SIGINT"), TIMEOUT_MS),
      setTimeout(() => child.kill("SIGINT"), TIMEOUT_MS + 5_000),
      setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS + 15_000),
    ];
    child.on("error", failed);
    child.on("close", (code) => {
      for (const timer of timers) clearTimeout(timer);
      done({ stdout, stderr, code });
    });
  });
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
  // Only Tenzo's state is redirected; Claude runs with your own config, as in a real thread.
  const env = { ...process.env, TENZO_HOME: join(root, "home") };
  const word = randomBytes(4).toString("hex");

  console.error(`Parity check in ${root} (model ${model})`);
  const repo = makeProject(root);
  run(process.execPath, [CLI, "project", "add", repo], { cwd: REPO_ROOT, env });
  const { stdout, stderr, code } = await startThread(repo, parityPrompt(word), model, env);
  writeFileSync(join(root, "events.jsonl"), stdout);
  writeFileSync(join(root, "tenzo.stderr"), stderr);

  const events = parseEvents(stdout);
  const worktree = events.find((e) => e.type === "session.configured")?.payload.cwd;
  const hookLog = worktree ? join(worktree, FIXTURE.hookLog) : undefined;
  const hooks = parseHookLog(hookLog && existsSync(hookLog) ? readFileSync(hookLog, "utf8") : null);
  const checks = checkParity(events, hooks, word);

  console.log(`\n${formatTable(checks)}`);
  if (events.length === 0) {
    console.log(`\ntenzo exited with ${code} and no events:\n${stderr.trim()}`);
  }
  return checks.every((c) => c.pass);
}

await main();
