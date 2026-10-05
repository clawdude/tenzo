import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AutomationView, type Automation, ThreadView } from "@tenzo/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter } from "./agent/fake-agent.ts";
import {
  Automations,
  budgetOf,
  nextAfterFiring,
  notesPath,
  PAUSED_FILE,
  runOfThread,
  runPrompt,
  runSummary,
  runTitle,
  scheduleOf,
} from "./automations.ts";
import { executeCommand } from "./commands.ts";
import { Engine, type EngineOptions } from "./engine.ts";
import { automationsOf, parseProjectConfig } from "./project-config.ts";
import { addProject, removeProject } from "./projects.ts";
import { openStore, type Store } from "./store.ts";
import { initRepo, removeTempDirs, sh, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

let home: string;
let repo: string;
let stores: Store[];
let engines: Engine[];

beforeEach(async () => {
  home = join(tempDir("home"), ".tenzo");
  repo = initRepo("app");
  stores = [];
  engines = [];
  const store = openStore(home);
  await addProject(store, repo);
  store.close();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const engine of engines) await engine.close();
  for (const store of stores) store.close();
});

function daemon(adapter = new FakeAdapter(), options: Pick<EngineOptions, "defaultModel"> = {}) {
  const store = openStore(home);
  stores.push(store);
  const engine = new Engine({ store, adapters: { claude: adapter }, log: () => {}, ...options });
  engines.push(engine);
  engine.start();
  return { engine, adapter, store };
}

async function stop(d: ReturnType<typeof daemon>) {
  await d.engine.close();
  engines.splice(engines.indexOf(d.engine), 1);
  stores.splice(stores.indexOf(d.store), 1);
  d.store.close();
}

/** Writes the project's `.tenzo/config.json` (in its main checkout, as a person would). */
function config(automations: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  mkdirSync(join(repo, ".tenzo"), { recursive: true });
  writeFileSync(join(repo, ".tenzo/config.json"), JSON.stringify({ ...extra, automations }, null, 2));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Waits for `check` to hold (a fire runs git, so it takes real time). */
async function until(check: () => boolean, what = "the condition"): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function view(d: ReturnType<typeof daemon>, name = "nightly"): AutomationView {
  const found = d.engine.snapshot().automations.find((a) => a.name === name);
  if (!found) throw new Error(`no automation ${name}`);
  return AutomationView.parse(found);
}

/** Makes the automation's next scheduled run due (as if its time came), then looks. */
async function due(d: ReturnType<typeof daemon>, name = "nightly", at = Date.now() - 1_000) {
  await d.engine.tickAutomations(); // its schedule is known
  d.store.db
    .prepare("UPDATE automations SET next_run_at = ? WHERE name = ?")
    .run(new Date(at).toISOString(), name);
  await d.engine.tickAutomations();
}

function runs(d: ReturnType<typeof daemon>, name?: string) {
  return d.store.db
    .prepare("SELECT name, trigger, result, reason, thread_id FROM automation_runs ORDER BY id")
    .all()
    .filter((r) => name === undefined || r.name === name)
    .map((r) => ({ trigger: r.trigger, result: r.result, reason: r.reason, threadId: r.thread_id }));
}

const NIGHTLY = { prompt: "Check the dependencies.", trigger: { schedule: "every 1h" } };

describe("automations: definitions", () => {
  it("local.json can switch one off or change one key; the merged one must be whole", () => {
    const committed = JSON.stringify({ automations: { nightly: NIGHTLY } });
    const off = parseProjectConfig({ config: committed, local: '{"automations":{"nightly":{"enabled":false}}}' });
    expect(automationsOf(off).nightly).toMatchObject({ prompt: "Check the dependencies.", enabled: false });
    const half = parseProjectConfig({ local: '{"automations":{"other":{"enabled":false}}}' });
    expect(half.problem).toMatch(/automations\.other\.prompt/);
    expect(automationsOf(half)).toEqual({});
    // A permission mode in an automation is no key of one: refused, like any unknown key.
    const sneaky = parseProjectConfig({
      config: JSON.stringify({ automations: { nightly: { ...NIGHTLY, permissions: "bypassPermissions" } } }),
    });
    expect(sneaky.problem).toMatch(/permissions/);
  });

  it("every run has a budget: 1h and $2 unless the file says otherwise", () => {
    expect(budgetOf({ prompt: "x" })).toEqual({ wallClockMs: 3_600_000, costUsd: 2 });
    expect(budgetOf({ prompt: "x", budget: { costUsd: 5 } })).toEqual({ wallClockMs: 3_600_000, costUsd: 5 });
    expect(budgetOf({ prompt: "x", budget: { wallClock: "10m" } })).toEqual({ wallClockMs: 600_000, costUsd: 2 });
  });

  it("missed times collapse into one, and a schedule starts at most every 5 minutes", () => {
    const every = scheduleOf({ prompt: "x", trigger: { schedule: "every 1h" } }, "UTC");
    const now = Date.UTC(2026, 9, 5, 12, 0);
    if (!every) throw new Error("no schedule");
    // On time: an hour after it was due.
    expect(nextAfterFiring(every.schedule, "UTC", now - 1_000, now)).toBe(now - 1_000 + 3_600_000);
    // Five hours late (the daemon was down): once now, then an hour from now.
    expect(nextAfterFiring(every.schedule, "UTC", now - 5 * 3_600_000, now)).toBe(now + 3_600_000);
    const daily = scheduleOf({ prompt: "x", trigger: { schedule: "daily 09:00" } }, "UTC");
    if (!daily) throw new Error("no schedule");
    expect(nextAfterFiring(daily.schedule, "UTC", now - 3 * 86_400_000, now)).toBe(Date.UTC(2026, 9, 6, 9));
    // A cron line every minute: the next one 5 minutes on.
    const minutely = scheduleOf({ prompt: "x", trigger: { schedule: "* * * * *" } }, "UTC");
    if (!minutely) throw new Error("no schedule");
    expect(nextAfterFiring(minutely.schedule, "UTC", now, now)).toBe(now + 5 * 60_000);
  });

  it("names a run's thread after the automation and when it ran", () => {
    expect(runTitle("nightly", Date.UTC(2026, 9, 5, 7, 5), "UTC")).toBe("nightly · Oct 5 07:05");
  });

  it("assembles a run's prompt: its own, which run this is, the previous run's words, the notes", () => {
    const automation: Automation = { prompt: "Review the open PRs.\n" };
    const first = runPrompt({ name: "prs", automation, trigger: "every 1h", previous: null, notes: null });
    expect(first.startsWith("Review the open PRs.\n\n---\n")).toBe(true);
    expect(first).toContain('a run of the automation "prs" (every 1h)');
    expect(first).toContain("This is its first run.");
    expect(first).toContain("`.tenzo/automations/prs.md`");
    expect(first).toContain("doesn't exist yet");
    // The notes file alone may be written and committed without a proposal.
    expect(first).toContain("commit it (that file alone)");
    expect(first).toContain("needs no proposal and no agreement first; any other change still does");
    expect(first).toContain("leave markers");

    const next = runPrompt({
      name: "prs",
      automation,
      trigger: "every 1h",
      previous: { at: "2026-10-05T07:00:00.000Z", threadId: "thr_aaaaaaaaaaaaaaaaaaaa", summary: "Reviewed #12.\n\nSkipped #13." },
      notes: { commit: "a".repeat(40), onBase: false },
    });
    expect(next).toContain("Previous run: 2026-10-05T07:00:00.000Z, thread thr_aaaaaaaaaaaaaaaaaaaa. What it said last:");
    expect(next).toContain("> Reviewed #12.\n>\n> Skipped #13.");
    expect(next).toContain(`git checkout ${"a".repeat(40)} -- .tenzo/automations/prs.md`);
    const onBase = runPrompt({ name: "prs", automation, trigger: "run by hand", previous: null, notes: { commit: "b".repeat(40), onBase: true } });
    expect(onBase).toContain("Your worktree has its latest version");
    expect(notesPath("prs")).toBe(".tenzo/automations/prs.md");
  });
});

describe("automations: running", () => {
  it("runs one by hand: an ordinary thread, origin automation, with its model and Tenzo's additions", async () => {
    config({ nightly: { ...NIGHTLY, model: "haiku", thinking: "low" } });
    const d = daemon();
    const result = await d.engine.runAutomation("app", "nightly");
    expect(result.run).toMatchObject({ result: "started", trigger: "manual", state: "going" });
    const thread = ThreadView.parse(result.thread);
    expect(thread).toMatchObject({ origin: "automation", automation: "nightly", model: "haiku", thinking: "low" });
    expect(thread.title).toMatch(/^nightly · /);
    const session = d.adapter.last;
    // Its own worktree, the ordinary discuss phase, no permission mode: nothing a thread you
    // start yourself wouldn't get. The default budget, as Claude's spend cap.
    expect(session.input).toMatchObject({ cwd: thread.worktreePath, phase: "discussing" });
    expect(session.input.permissionMode).toBeUndefined();
    expect(session.input.budget).toEqual({ capUsd: 2, spentUsd: 0 });
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toMatch(/^Check the dependencies\.\n\n---\n/);
    expect(session.prompts[0]).toContain("This is its first run.");
    const a = view(d);
    expect(a).toMatchObject({
      enabled: true,
      schedule: "every 1h",
      model: "haiku",
      budget: { wallClockMs: 3_600_000, costUsd: 2 },
      lastRun: { threadId: thread.id },
    });
    // The same over the wire.
    const listed = await executeCommand(d.engine, { type: "automation.list", project: "app" });
    expect(listed).toMatchObject({ ok: true, result: { paused: false, automations: [{ name: "nightly" }] } });
    const missing = await executeCommand(d.engine, { type: "automation.run", project: "app", name: "weekly" });
    expect(missing).toMatchObject({ ok: false, fault: "client", error: expect.stringContaining('no automation "weekly" (it has nightly)') });
  });

  it("schedules what the config says, at once; switched off, nothing", async () => {
    config({ nightly: NIGHTLY });
    const d = daemon();
    await d.engine.tickAutomations();
    const next = Date.parse(view(d).nextRunAt ?? "");
    expect(next - Date.now()).toBeGreaterThan(59 * 60_000);
    await due(d);
    await until(() => d.adapter.sessions.length === 1, "the scheduled run");
    expect(runs(d)).toMatchObject([{ trigger: "schedule", result: "started" }]);
    config({ nightly: { ...NIGHTLY, enabled: false } });
    await d.engine.tickAutomations();
    expect(view(d)).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it("fires when due, skips while the previous run is going, and starts again once it finished", async () => {
    config({ nightly: NIGHTLY });
    const d = daemon();
    const first = await d.engine.runAutomation("app", "nightly");
    const a = d.adapter.last;
    await due(d);
    await settle();
    expect(d.adapter.sessions).toHaveLength(1);
    expect(view(d).lastRun).toMatchObject({
      trigger: "schedule",
      result: "skipped",
      threadId: null,
      reason: expect.stringContaining(`(${first.thread?.id}) is still going`),
    });
    // The next one is an hour on, not now again.
    expect(Date.parse(view(d).nextRunAt ?? "") - Date.now()).toBeGreaterThan(59 * 60_000);

    a.say("Two upgrades are due: zod and hono.");
    a.complete("completed", { costUsd: 0.02 });
    await settle();
    await due(d);
    await until(() => d.adapter.sessions.length === 2, "the second run");
    expect(view(d).lastRun).toMatchObject({ trigger: "schedule", result: "started", state: "going" });
    const b = d.adapter.last;
    expect(b.input.cwd).not.toBe(a.input.cwd);
    expect(b.prompts[0]).toContain(`thread ${first.thread?.id}. What it said last:`);
    expect(b.prompts[0]).toContain("> Two upgrades are due: zod and hono.");
    expect(runs(d).map((r) => `${r.trigger}:${r.result}`)).toEqual(["manual:started", "schedule:skipped", "schedule:started"]);
    // Run now while it is going: skipped too, and said so.
    const skipped = await d.engine.runAutomation("app", "nightly");
    expect(skipped).toMatchObject({ run: { result: "skipped" }, thread: null });
    // Finished again, but due within 5 minutes of the last scheduled start: not started, put off.
    b.complete();
    await settle();
    await due(d);
    await settle();
    expect(d.adapter.sessions).toHaveLength(2);
    expect(Date.parse(view(d).nextRunAt ?? "") - Date.now()).toBeGreaterThan(4 * 60_000);
  });

  it("says a previous run that waits on you is waiting on you", async () => {
    config({ nightly: NIGHTLY });
    const d = daemon();
    const first = await d.engine.runAutomation("app", "nightly");
    d.adapter.last.complete("failed");
    await settle();
    expect(view(d).lastRun?.state).toBe("waiting");
    const skipped = await d.engine.runAutomation("app", "nightly");
    expect(skipped.run.reason).toBe(`Its previous run (${first.thread?.id}) is waiting on you.`);
  });

  it("archives a finished run with nothing to keep when the next starts; one with commits stays", async () => {
    config({ nightly: NIGHTLY });
    const d = daemon();
    const first = await d.engine.runAutomation("app", "nightly");
    d.adapter.last.say("Nothing to do.");
    d.adapter.last.complete();
    await settle();
    const second = await d.engine.runAutomation("app", "nightly");
    expect(d.engine.view(first.thread?.id ?? "").status).toBe("archived");
    expect(sh(repo, "branch", "--list", first.thread?.branch ?? "")).not.toBe(""); // kept
    // The second commits something: it stays for you when the third starts.
    const worktree = second.thread?.worktreePath ?? "";
    writeFileSync(join(worktree, "CHANGES.md"), "upgraded\n");
    sh(worktree, "add", ".");
    sh(worktree, "commit", "--quiet", "-m", "upgrade");
    d.adapter.last.complete();
    await settle();
    await d.engine.runAutomation("app", "nightly");
    expect(d.engine.view(second.thread?.id ?? "").status).toBe("active");
    // A finished card waiting for you keeps a run too.
    d.adapter.last.report("Upgraded.");
    d.adapter.last.complete();
    await settle();
    const third = d.engine.snapshot().automations[0]?.lastRun?.threadId ?? "";
    await d.engine.runAutomation("app", "nightly");
    expect(d.engine.view(third).status).toBe("active");
  });

  it("points a run at the notes its previous run committed on its branch", async () => {
    config({ nightly: NIGHTLY });
    const d = daemon();
    const first = await d.engine.runAutomation("app", "nightly");
    const worktree = first.thread?.worktreePath ?? "";
    mkdirSync(join(worktree, ".tenzo/automations"), { recursive: true });
    writeFileSync(join(worktree, notesPath("nightly")), "Upgraded zod. Next: hono.\n");
    sh(worktree, "add", ".");
    sh(worktree, "commit", "--quiet", "-m", "nightly notes");
    const commit = sh(worktree, "rev-parse", "HEAD");
    d.adapter.last.say("Done.");
    d.adapter.last.complete();
    await settle();
    await d.engine.runAutomation("app", "nightly");
    expect(d.adapter.last.prompts[0]).toContain(`git checkout ${commit} -- .tenzo/automations/nightly.md`);
    // Its run had a commit (the notes), so it isn't archived.
    expect(d.engine.view(first.thread?.id ?? "").status).toBe("active");
  });

  it("carries the previous run's report as its summary", async () => {
    config({ nightly: NIGHTLY });
    const d = daemon();
    const first = await d.engine.runAutomation("app", "nightly");
    const a = d.adapter.last;
    a.say("Some chatter.");
    a.report("Bumped zod to 4.6.", { headline: "Upgraded zod" });
    a.complete();
    await settle();
    expect(runSummary(d.store, first.thread?.id as never)).toBe("Upgraded zod: Bumped zod to 4.6.");
    // Finished work waiting for review: the run is done, the next one starts.
    expect(view(d).lastRun?.state).toBe("finished");
    await d.engine.runAutomation("app", "nightly");
    expect(d.adapter.last.prompts[0]).toContain("> Upgraded zod: Bumped zod to 4.6.");
  });

  it("a broken config starts nothing, and running one by hand says why", async () => {
    config({ nightly: { ...NIGHTLY, trigger: { schedule: "every 1m" } } });
    const d = daemon();
    await d.engine.tickAutomations();
    expect(d.engine.snapshot().automations).toEqual([]);
    await expect(d.engine.runAutomation("app", "nightly")).rejects.toThrow(/config is invalid.*at most every 5 minutes/);
    expect(d.adapter.sessions).toHaveLength(0);
  });

  it("runs a schedule missed while no daemon ran once on start, not once per missed time", async () => {
    config({ nightly: NIGHTLY });
    const first = daemon();
    await first.engine.tickAutomations();
    await stop(first);
    // Five hours pass with no daemon: five runs missed.
    const store = openStore(home);
    store.db.prepare("UPDATE automations SET next_run_at = ?").run(new Date(Date.now() - 5 * 3_600_000).toISOString());
    store.close();

    const second = daemon();
    await until(() => second.adapter.sessions.length === 1, "the missed run");
    await settle();
    expect(runs(second).map((r) => `${r.trigger}:${r.result}`)).toEqual(["schedule:started"]);
    const next = Date.parse(view(second).nextRunAt ?? "");
    expect(next - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(next - Date.now()).toBeLessThanOrEqual(3_600_000);
    // A second look finds nothing due.
    await second.engine.tickAutomations();
    expect(second.adapter.sessions).toHaveLength(1);
  });

  it("at most 3 runs go at once: a schedule due beyond that is skipped, and said so", async () => {
    const four = Object.fromEntries(["a", "b", "c", "d"].map((n) => [n, NIGHTLY]));
    config(four);
    const d = daemon();
    for (const name of ["a", "b", "c"]) await d.engine.runAutomation("app", name);
    // By hand is never held: a fourth by hand would start. A schedule isn't.
    await due(d, "d");
    await settle();
    expect(d.adapter.sessions).toHaveLength(3);
    expect(runs(d, "d")).toEqual([
      expect.objectContaining({ result: "skipped", reason: expect.stringContaining("Too many automation runs going") }),
    ]);
  });

  it("the off switch lives in Tenzo's home: while on, no schedule starts a run", async () => {
    config({ nightly: NIGHTLY });
    const d = daemon();
    expect(await executeCommand(d.engine, { type: "automation.pause", paused: true })).toMatchObject({
      ok: true,
      result: { paused: true },
    });
    expect(existsSync(join(home, PAUSED_FILE))).toBe(true);
    expect(d.engine.snapshot().automationsPaused).toBe(true);
    await due(d);
    await settle();
    expect(d.adapter.sessions).toHaveLength(0);
    expect(runs(d)).toMatchObject([{ result: "skipped", reason: expect.stringContaining("paused") }]);
    // Run by hand still works.
    await d.engine.runAutomation("app", "nightly");
    expect(d.adapter.sessions).toHaveLength(1);
    d.adapter.last.complete();
    await settle();
    // It outlives the daemon.
    await stop(d);
    const again = daemon();
    expect(again.engine.automationsPaused).toBe(true);
    again.engine.pauseAutomations(false);
    expect(existsSync(join(home, PAUSED_FILE))).toBe(false);
    await due(again);
    await until(() => again.adapter.sessions.length === 1, "the run after resuming");
  });
});

describe("automations: the scheduler never spins", () => {
  /** Counts the scheduler's looks over 1.2 s once `setup` left a stale time behind. */
  async function looksAfter(setup: (d: ReturnType<typeof daemon>) => Promise<void> | void) {
    config({ nightly: NIGHTLY });
    const d = daemon();
    await d.engine.tickAutomations();
    await setup(d);
    d.store.db.prepare("UPDATE automations SET next_run_at = ?").run(new Date(Date.now() - 60_000).toISOString());
    const tick = vi.spyOn(Automations.prototype, "tick");
    await d.engine.tickAutomations();
    tick.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    return { d, looks: tick.mock.calls.length };
  }

  it("an automation deleted from the config", async () => {
    const { d, looks } = await looksAfter(() => config({}));
    expect(looks).toBe(0);
    expect(d.store.db.prepare("SELECT next_run_at FROM automations").get()?.next_run_at).toBeNull();
    expect(d.adapter.sessions).toHaveLength(0);
  });

  it("a config that became invalid", async () => {
    const { d, looks } = await looksAfter(() => config({ nightly: { ...NIGHTLY, oops: true } }));
    expect(looks).toBe(0);
    expect(d.adapter.sessions).toHaveLength(0);
  });

  it("a removed project", async () => {
    const { d, looks } = await looksAfter(async (d) => {
      await removeProject(d.store, "app");
    });
    expect(looks).toBe(0);
    expect(d.store.db.prepare("SELECT next_run_at FROM automations").get()?.next_run_at).toBeNull();
  });
});

describe("automations: budgets", () => {
  const BUDGETED = { ...NIGHTLY, budget: { costUsd: 0.5 } };

  function budgetCard(d: ReturnType<typeof daemon>) {
    return d.engine.snapshot().items.find((i) => i.kind === "error" && i.error?.cause === "budget");
  }

  it("a run that spends its budget is paused and asks; Continue grants as much again from there", async () => {
    config({ nightly: BUDGETED });
    const d = daemon();
    const { thread } = await d.engine.runAutomation("app", "nightly");
    const session = d.adapter.last;
    // Claude gets the cap, to stop a turn there by itself.
    expect(session.input.budget).toEqual({ capUsd: 0.5, spentUsd: 0 });
    d.engine.send(thread?.id ?? "", "And the lockfile.");
    // One call went far past the cap.
    session.complete("completed", { costUsd: 1.7 });
    await settle();
    const card = budgetCard(d);
    expect(card).toMatchObject({
      lane: "quick",
      ask: "Budget reached: paused",
      options: [{ label: "Continue", value: "retry" }, { label: "Stop", value: "archive" }],
      suggested: "retry",
    });
    expect(card?.error?.message).toMatch(/spent \$1\.70, and its cap is \$0\.50/);
    // Paused: the queued message waits.
    expect(session.prompts).toHaveLength(1);
    expect(view(d).lastRun).toMatchObject({ state: "paused", costUsd: 1.7 });
    // A schedule meanwhile is skipped: the run isn't done.
    await due(d);
    expect(view(d).lastRun).toMatchObject({ result: "skipped", reason: expect.stringContaining("paused") });

    // Claude can't take a new cap live: the session starts again with it. One Continue is
    // enough, however far past the cap the last call went: $1.70 + $0.50.
    session.reconfigureResult = "restart";
    const answered = await d.engine.answer(card?.id ?? "", { kind: "error", action: "retry" });
    expect(answered.delivery).toBe("message");
    await until(() => d.adapter.sessions.length === 2, "the restarted session");
    const resumed = d.adapter.last;
    expect(resumed.input.budget?.capUsd).toBeCloseTo(2.2);
    expect(resumed.input.budget?.spentUsd).toBe(1.7);
    await settle();
    expect(resumed.prompts[0]).toBe("And the lockfile.");
    expect(budgetCard(d)).toBeUndefined();
    resumed.complete("completed", { costUsd: 1.8 });
    await settle();
    expect(resumed.prompts[1]).toMatch(/^Tenzo paused you: this run of the automation "nightly" reached its budget/);
  });

  it("a turn Claude stopped at its cap pauses the run, and only the budget card asks", async () => {
    config({ nightly: BUDGETED });
    const d = daemon();
    await d.engine.runAutomation("app", "nightly");
    d.adapter.last.askPermission("Write", { file_path: "notes.md" });
    await settle();
    d.adapter.last.complete("interrupted", { costUsd: 0.49, stoppedBy: "budget" });
    await settle();
    expect(budgetCard(d)?.error?.message).toMatch(/Claude stopped at the spend it was allowed/);
    // The permission card of that turn went with it: nothing waits on it.
    expect(d.engine.snapshot().items.map((i) => i.error?.cause ?? i.kind)).toEqual(["budget"]);
    // No second card for the same pause.
    d.engine.send(d.engine.threads()[0]?.id ?? "", "Go on.");
    await settle();
    expect(d.engine.snapshot().items.filter((i) => i.error?.cause === "budget")).toHaveLength(1);
  });

  it("a run's budget ends when it finishes: what you ask of it afterwards isn't held", async () => {
    config({ nightly: BUDGETED });
    const d = daemon();
    const { thread } = await d.engine.runAutomation("app", "nightly");
    const session = d.adapter.last;
    session.complete("completed", { costUsd: 0.1 });
    await settle();
    expect(view(d).lastRun?.state).toBe("finished");
    expect(runOfThread(d.store, thread?.id as never)?.finishedAt).not.toBeNull();
    d.engine.send(thread?.id ?? "", "Now do it all again.");
    await settle();
    session.complete("completed", { costUsd: 5 });
    await settle();
    expect(budgetCard(d)).toBeUndefined();
  });

  it("wall clock: a turn still running at the deadline is interrupted and asks; Stop archives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      config({ nightly: { ...NIGHTLY, budget: { wallClock: "10m" } } });
      const d = daemon();
      const { thread } = await d.engine.runAutomation("app", "nightly");
      const session = d.adapter.last;
      vi.advanceTimersByTime(9 * 60_000);
      await settle();
      expect(budgetCard(d)).toBeUndefined();
      vi.advanceTimersByTime(60_000);
      await settle();
      expect(budgetCard(d)?.error?.message).toMatch(/its 10m of wall clock ran out/);
      expect(session.turnId).toBeNull(); // interrupted, not stopped
      expect(session.stopped).toBe(false);
      expect(d.engine.events(thread?.id ?? "").events.at(-1)?.event).toMatchObject({
        type: "turn.completed",
        payload: { state: "interrupted" },
      });
      // Nothing else came: no "turn failed" card next to it.
      expect(d.engine.snapshot().items).toHaveLength(1);
      const card = budgetCard(d);
      const stopped = await d.engine.answer(card?.id ?? "", { kind: "error", action: "archive" });
      expect(stopped).toMatchObject({ delivery: "archived", thread: { status: "archived" } });
      expect(view(d).lastRun?.state).toBe("archived");
    } finally {
      vi.useRealTimers();
    }
  });

  it("wall clock: Continue hours later grants a fresh stretch from then, not from the start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      config({ nightly: { ...NIGHTLY, budget: { wallClock: "10m" } } });
      const d = daemon();
      await d.engine.runAutomation("app", "nightly");
      const session = d.adapter.last;
      vi.advanceTimersByTime(10 * 60_000);
      await settle();
      const card = budgetCard(d);
      expect(card).toBeDefined();
      // You answer from your phone two hours later.
      vi.advanceTimersByTime(2 * 3_600_000);
      await d.engine.answer(card?.id ?? "", { kind: "error", action: "retry" });
      await settle();
      expect(budgetCard(d)).toBeUndefined();
      expect(session.prompts.at(-1)).toMatch(/^Tenzo paused you/);
      vi.advanceTimersByTime(9 * 60_000);
      await settle();
      expect(budgetCard(d)).toBeUndefined();
      vi.advanceTimersByTime(60_000);
      await settle();
      expect(budgetCard(d)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wall clock: a run waiting on your answer isn't cut off; it is looked at again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      config({ nightly: { ...NIGHTLY, budget: { wallClock: "1m" } } });
      const d = daemon();
      await d.engine.runAutomation("app", "nightly");
      const session = d.adapter.last;
      const asked = session.ask([
        {
          id: "Which?",
          header: "Which",
          question: "Which?",
          options: [{ label: "A", value: "A", description: "", recommended: true }],
          multiSelect: false,
        },
      ]);
      await settle();
      vi.advanceTimersByTime(61_000);
      await settle();
      expect(budgetCard(d)).toBeUndefined();
      expect(session.pending.has(asked)).toBe(true);
      // Answered: it works on, and at the next look it is paused.
      session.respondToUserInput(asked, { "Which?": "A" });
      await settle();
      vi.advanceTimersByTime(60_000);
      await settle();
      expect(budgetCard(d)).toBeDefined();
      expect(session.turnId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a paused run stays paused across a restart", async () => {
    config({ nightly: BUDGETED });
    const first = daemon();
    const { thread } = await first.engine.runAutomation("app", "nightly");
    first.adapter.last.complete("completed", { costUsd: 0.9 });
    await settle();
    first.engine.send(thread?.id ?? "", "Keep going.");
    await stop(first);
    const second = daemon();
    await settle();
    expect(second.adapter.sessions).toHaveLength(0);
    expect(budgetCard(second)).toBeDefined();
    expect(second.engine.view(thread?.id ?? "")).toMatchObject({ origin: "automation", queued: 1 });
  });
});
