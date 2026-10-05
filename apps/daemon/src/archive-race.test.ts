import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter } from "./agent/fake-agent.ts";
import { Engine } from "./engine.ts";
import { addProject } from "./projects.ts";
import { openStore, type Store } from "./store.ts";
import { initRepo, removeTempDirs, tempDir } from "./testing.ts";

/**
 * Archiving waits on git (is the worktree clean? remove it). A message that comes in meanwhile
 * must never be dropped by an archive that started before it: these tests hold git where the
 * reviewer's race fell (a slow `git status`, a slow worktree removal) and send then.
 */

const gates = vi.hoisted(() => ({
  /** When set, `checkArchivable` waits for it: a slow `git status`. */
  check: null as Promise<void> | null,
  /** When set, `archiveThread` waits for it: a slow worktree removal. */
  remove: null as Promise<void> | null,
  /** Calls that reached a gate. */
  reached: [] as string[],
}));

vi.mock("./threads.ts", async (original) => {
  const real = await original<typeof import("./threads.ts")>();
  return {
    ...real,
    checkArchivable: async (...args: Parameters<typeof real.checkArchivable>) => {
      if (gates.check) {
        gates.reached.push("check");
        await gates.check;
      }
      return real.checkArchivable(...args);
    },
    archiveThread: async (...args: Parameters<typeof real.archiveThread>) => {
      if (gates.remove) {
        gates.reached.push("remove");
        await gates.remove;
      }
      return real.archiveThread(...args);
    },
  };
});

afterAll(removeTempDirs);

let repo: string;
let store: Store;
let engine: Engine;
let adapter: FakeAdapter;

beforeEach(async () => {
  const home = join(tempDir("home"), ".tenzo");
  repo = initRepo("app");
  mkdirSync(join(repo, ".tenzo"), { recursive: true });
  writeFileSync(
    join(repo, ".tenzo/config.json"),
    JSON.stringify({ automations: { nightly: { prompt: "Check.", trigger: { schedule: "every 1h" } } } }),
  );
  store = openStore(home);
  await addProject(store, repo);
  adapter = new FakeAdapter();
  engine = new Engine({ store, adapters: { claude: adapter }, log: () => {} });
  engine.start();
  gates.check = null;
  gates.remove = null;
  gates.reached = [];
});
afterEach(async () => {
  await engine.close();
  store.close();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** A finished run with a finished card: what "Archive finished runs" archives. */
async function finishedRun() {
  const { thread } = await engine.runAutomation("app", "nightly");
  if (!thread) throw new Error("no run");
  adapter.last.report("Checked.");
  adapter.last.complete();
  await settle();
  return thread;
}

describe("archiving finished runs vs. a message", () => {
  it("a message sent while the archive checks the worktree keeps the run, and reaches the agent", async () => {
    const thread = await finishedRun();
    const slow = gate();
    gates.check = slow.promise;
    const archiving = engine.archiveFinishedRuns("app", "nightly");
    await until(() => gates.reached.includes("check"), "the slow git status");
    // The run is still finished as far as anyone can tell: the message is taken.
    engine.send(thread.id, "One more thing: check hono too.");
    slow.open();
    const result = await archiving;
    expect(result.archived).toEqual([]);
    expect(engine.view(thread.id).status).toBe("active");
    await until(() => adapter.last.prompts.includes("One more thing: check hono too."), "the message");
  });

  it("refuses a message once archiving has started, rather than losing it", async () => {
    const thread = await finishedRun();
    const slow = gate();
    gates.remove = slow.promise;
    const archiving = engine.archiveFinishedRuns("app", "nightly");
    await until(() => gates.reached.includes("remove"), "the slow worktree removal");
    expect(() => engine.send(thread.id, "Too late?")).toThrow(/is being archived/);
    slow.open();
    const result = await archiving;
    expect(result.archived.map((t) => t.id)).toEqual([thread.id]);
    expect(adapter.last.prompts).not.toContain("Too late?");
  });
});
