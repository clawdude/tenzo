import { createHash } from "node:crypto";
import {
  type Automation,
  type AutomationRunView,
  type AutomationView,
  durationMs,
  localTimeZone,
  nextRun,
  parseSchedule,
  type ProjectId,
  type Schedule,
  type ThinkingLevel,
  type ThreadId,
  type ThreadView,
  wallOf,
} from "@tenzo/contracts";
import { TenzoError } from "./errors.ts";
import { branchExists, latestChange, resolveBase } from "./git.ts";
import { automationsOf, type ConfigRead } from "./project-config.ts";
import { findProject, listProjects, type Project } from "./projects.ts";
import type { Store } from "./store.ts";
import { Timers } from "./timers.ts";

/**
 * Automations (PRODUCT.md §7): saved thread recipes a project's `.tenzo/config.json` defines (a
 * prompt, a schedule or none, a budget), run as ordinary threads with origin `automation`.
 *
 * The daemon keeps only what the files can't: each automation's next scheduled run (so a
 * schedule survives a restart; runs missed while no daemon ran come once, on start, not once per
 * missed time), which definition you last ran by hand, and every run (started, skipped, failed),
 * with a started run's budget and what it has used. Budgets are the engine's to watch (it sees
 * the turns); this module starts the runs.
 *
 * A file in the repo defines an automation, so the repo, not you, wrote its prompt. It only ever
 * starts an ordinary thread, with your own permissions and nothing more. And its schedule runs
 * only a definition you have run by hand once (`approved`): a new automation, or one a pull or a
 * teammate's commit changed, waits for you before it starts threads by itself.
 */

/** What one run may use: wall clock from its start, and Claude's reported spend. */
export interface RunBudget {
  wallClockMs?: number;
  costUsd?: number;
}

export interface AutomationRun {
  id: number;
  projectId: ProjectId;
  name: string;
  trigger: "schedule" | "manual";
  result: "started" | "skipped" | "failed";
  reason: string | null;
  threadId: ThreadId | null;
  at: string;
  budget: RunBudget | null;
  /** Budgets granted: 1, and one more for each Continue on its budget card. */
  allowance: number;
  /** Claude's running total for the run's session, the highest seen; null before a turn ended. */
  costUsd: number | null;
  /** When the run's agent was first done: its budget no longer applies. */
  finishedAt: string | null;
}

/** How many runs without a thread (skipped, failed) are kept per automation. */
const KEEP_EMPTY_RUNS = 50;

/** The previous run's words a new run's prompt carries, at most. */
export const SUMMARY_LIMIT = 1_500;

/** How often the scheduler looks at the configs again when nothing is due sooner. */
export const TICK_MS = 60_000;

/** The notes file an automation's runs keep for each other, in the repo. */
export function notesPath(name: string): string {
  return `.tenzo/automations/${name}.md`;
}

/** A definition's fingerprint: what you approve by running it by hand. `enabled` isn't in it. */
export function definitionHash(automation: Automation): string {
  const { prompt, trigger, budget, model, thinking } = automation;
  const canonical = JSON.stringify({
    prompt,
    schedule: trigger?.schedule?.trim() ?? null,
    timeZone: trigger?.timeZone ?? null,
    wallClock: budget?.wallClock ?? null,
    costUsd: budget?.costUsd ?? null,
    model: model ?? null,
    thinking: thinking ?? null,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** The automation's schedule and the time zone it is read in; null when it has none. */
export function scheduleOf(
  automation: Automation,
  machineZone = localTimeZone(),
): { schedule: Schedule; timeZone: string; key: string } | null {
  const text = automation.trigger?.schedule;
  if (text === undefined) return null;
  const schedule = parseSchedule(text);
  if (typeof schedule === "string") return null; // the config check refused it already
  const timeZone = automation.trigger?.timeZone ?? machineZone;
  return { schedule, timeZone, key: `${schedule.text}|${timeZone}` };
}

/**
 * When a schedule comes next after it came at `scheduledAt` and fired at `now`. An interval
 * counts from when it was due, unless that has passed too (the daemon was down): then from now.
 * Missed times never pile up: whatever was missed ran once, now.
 */
export function nextAfterFiring(
  schedule: Schedule,
  timeZone: string,
  scheduledAt: number,
  now: number,
): number | null {
  if (schedule.kind === "every") {
    const due = scheduledAt + schedule.ms;
    return due > now ? due : now + schedule.ms;
  }
  return nextRun(schedule, timeZone, now);
}

/** The budget a run starts with, from its definition; null when it has none. */
export function budgetOf(automation: Automation): RunBudget | null {
  const wallClockMs = automation.budget?.wallClock ? durationMs(automation.budget.wallClock) : null;
  const costUsd = automation.budget?.costUsd;
  if (wallClockMs === null && costUsd === undefined) return null;
  return {
    ...(wallClockMs !== null ? { wallClockMs } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** "every 1h (Europe/Rome)", or "run by hand" for an automation without a schedule. */
export function describeTrigger(automation: Automation, machineZone = localTimeZone()): string {
  const scheduled = scheduleOf(automation, machineZone);
  if (!scheduled) return "run by hand";
  return scheduled.schedule.kind === "every"
    ? scheduled.schedule.text
    : `${scheduled.schedule.text} (${scheduled.timeZone})`;
}

/** What a run's prompt is made of. */
export interface RunPromptInput {
  name: string;
  automation: Automation;
  /** "every 1h", "daily 09:00 (Europe/Rome)", "run by hand". */
  trigger: string;
  /** The previous run that started a thread, with what it said last; null for the first. */
  previous: { at: string; threadId: string; summary: string | null } | null;
  /**
   * The newest version of the notes file across the runs' branches: in the worktree already
   * (`onBase`), in a commit the worktree doesn't have, or nowhere yet (null).
   */
  notes: { commit: string; onBase: boolean } | null;
}

/**
 * A run's first prompt: the automation's own prompt, then what Tenzo adds: which automation this
 * is, what its previous run said, and where its notes are. Tenzo never writes the notes file;
 * the agent may (and commits it on its branch, where the next run is pointed to it).
 */
export function runPrompt(input: RunPromptInput): string {
  const { name, automation, trigger, previous, notes } = input;
  const path = notesPath(name);
  const lines = [
    automation.prompt.trim(),
    "",
    "---",
    `This thread is a run of the automation "${name}" (${trigger}), started by Tenzo; the person reads its cards on their phone.`,
  ];
  if (previous) {
    lines.push(
      "",
      `Previous run: ${previous.at}, thread ${previous.threadId}.${previous.summary ? " What it said last:" : " It said nothing at the end."}`,
    );
    if (previous.summary) lines.push(...quote(previous.summary));
  } else {
    lines.push("", "This is its first run.");
  }
  const where =
    notes === null
      ? "It doesn't exist yet: create it if there is anything worth remembering."
      : notes.onBase
        ? "Your worktree has its latest version: read it first."
        : `Its latest version is in commit ${notes.commit}, which this worktree doesn't have: take it first with \`git checkout ${notes.commit} -- ${path}\`, then read it.`;
  lines.push(
    "",
    `Notes: \`${path}\` is this automation's notes file, what one run leaves for the next (what you did, where you left off). ${where} Before you end, update it if something is worth keeping and commit it to this thread's branch; the next run is pointed to it. Also leave markers in the systems you work in (a comment, a label) so a later run can tell what's done.`,
  );
  return lines.join("\n");
}

function quote(text: string): string[] {
  return text.split("\n").map((line) => (line.trim() === "" ? ">" : `> ${line}`));
}

/** What a run said last: its latest report, else its last answer, cut to `SUMMARY_LIMIT`. */
export function runSummary(store: Store, threadId: ThreadId): string | null {
  const report = store.db
    .prepare(
      "SELECT body FROM events WHERE thread_id = ? AND type = 'report.submitted' ORDER BY seq DESC LIMIT 1",
    )
    .get(threadId);
  if (report) {
    const payload = JSON.parse(String(report.body)).payload as { headline?: string; summary?: string };
    const text = [payload.headline, payload.summary].filter((s) => s?.trim()).join(": ");
    if (text.trim()) return cut(text.trim());
  }
  const rows = store.db
    .prepare(
      `SELECT body FROM events WHERE thread_id = ? AND type IN ('turn.completed', 'item.completed')
       ORDER BY seq DESC LIMIT 200`,
    )
    .all(threadId);
  for (const row of rows) {
    const event = JSON.parse(String(row.body)) as {
      type: string;
      payload: { result?: string; itemType?: string; parentItemId?: string; text?: string };
    };
    const text =
      event.type === "turn.completed"
        ? event.payload.result
        : event.payload.itemType === "assistant_message" && !event.payload.parentItemId
          ? event.payload.text
          : undefined;
    if (text?.trim()) return cut(text.trim());
  }
  return null;
}

function cut(text: string, limit = SUMMARY_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** A run's thread title: the automation's name and when it ran, on this machine's clock. */
export function runTitle(name: string, at: number, timeZone = localTimeZone()): string {
  const wall = wallOf(at, timeZone);
  const month = new Date(Date.UTC(2000, wall.month - 1, 1)).toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const two = (n: number) => String(n).padStart(2, "0");
  return `${name} · ${month} ${wall.day} ${two(wall.hour)}:${two(wall.minute)}`;
}

// The database.

interface AutomationRow {
  approved: string | null;
  scheduleKey: string | null;
  nextRunAt: string | null;
}

function getRow(store: Store, projectId: ProjectId, name: string): AutomationRow | undefined {
  const row = store.db
    .prepare("SELECT approved, schedule_key, next_run_at FROM automations WHERE project_id = ? AND name = ?")
    .get(projectId, name);
  if (!row) return undefined;
  return {
    approved: row.approved === null ? null : String(row.approved),
    scheduleKey: row.schedule_key === null ? null : String(row.schedule_key),
    nextRunAt: row.next_run_at === null ? null : String(row.next_run_at),
  };
}

function saveRow(store: Store, projectId: ProjectId, name: string, row: AutomationRow): void {
  store.db
    .prepare(
      `INSERT INTO automations (project_id, name, environment_id, approved, schedule_key, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, name) DO UPDATE SET
         approved = excluded.approved, schedule_key = excluded.schedule_key,
         next_run_at = excluded.next_run_at`,
    )
    .run(projectId, name, store.environmentId, row.approved, row.scheduleKey, row.nextRunAt);
}

/** Records a run; keeps the last `KEEP_EMPTY_RUNS` that started nothing. */
export function insertRun(
  store: Store,
  run: Omit<AutomationRun, "id" | "allowance" | "costUsd" | "finishedAt">,
): AutomationRun {
  const { lastInsertRowid } = store.db
    .prepare(
      `INSERT INTO automation_runs
         (environment_id, project_id, name, trigger, result, reason, thread_id, at, budget)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      store.environmentId,
      run.projectId,
      run.name,
      run.trigger,
      run.result,
      run.reason,
      run.threadId,
      run.at,
      run.budget === null ? null : JSON.stringify(run.budget),
    );
  store.db
    .prepare(
      `DELETE FROM automation_runs
       WHERE project_id = :project AND name = :name AND thread_id IS NULL AND id NOT IN (
         SELECT id FROM automation_runs
         WHERE project_id = :project AND name = :name AND thread_id IS NULL
         ORDER BY id DESC LIMIT :keep)`,
    )
    .run({ project: run.projectId, name: run.name, keep: KEEP_EMPTY_RUNS });
  return { ...run, id: Number(lastInsertRowid), allowance: 1, costUsd: null, finishedAt: null };
}

function toRun(row: Record<string, unknown>): AutomationRun {
  return {
    id: Number(row.id),
    projectId: String(row.project_id) as ProjectId,
    name: String(row.name),
    trigger: row.trigger === "schedule" ? "schedule" : "manual",
    result: row.result === "started" || row.result === "skipped" ? row.result : "failed",
    reason: row.reason === null ? null : String(row.reason),
    threadId: row.thread_id === null ? null : (String(row.thread_id) as ThreadId),
    at: String(row.at),
    budget: row.budget === null ? null : (JSON.parse(String(row.budget)) as RunBudget),
    allowance: Number(row.allowance),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

/** The run a thread is, if it is one. */
export function runOfThread(store: Store, threadId: ThreadId): AutomationRun | undefined {
  const row = store.db.prepare("SELECT * FROM automation_runs WHERE thread_id = ?").get(threadId);
  return row ? toRun(row) : undefined;
}

/** The automation's latest run, and its latest run that started a thread. */
function lastRuns(
  store: Store,
  projectId: ProjectId,
  name: string,
): { last: AutomationRun | undefined; started: AutomationRun[] } {
  const last = store.db
    .prepare("SELECT * FROM automation_runs WHERE project_id = ? AND name = ? ORDER BY id DESC LIMIT 1")
    .get(projectId, name);
  const started = store.db
    .prepare(
      `SELECT * FROM automation_runs WHERE project_id = ? AND name = ? AND result = 'started'
       ORDER BY id DESC LIMIT 20`,
    )
    .all(projectId, name);
  return { last: last ? toRun(last) : undefined, started: started.map(toRun) };
}

/** Runs whose budget still applies (not finished): the engine arms their wall clocks on start. */
export function unfinishedRuns(store: Store): AutomationRun[] {
  return store.db
    .prepare(
      `SELECT r.* FROM automation_runs r JOIN threads t ON t.id = r.thread_id
       WHERE r.finished_at IS NULL AND r.budget IS NOT NULL AND t.status = 'active'`,
    )
    .all()
    .map(toRun);
}

/** Claude's running total for the run, kept at its highest (a crashed turn may report 0). */
export function recordCost(store: Store, runId: number, costUsd: number): void {
  if (!Number.isFinite(costUsd) || costUsd < 0) return;
  store.db
    .prepare("UPDATE automation_runs SET cost_usd = MAX(COALESCE(cost_usd, 0), ?) WHERE id = ?")
    .run(costUsd, runId);
}

/** Continue on a budget card: the run gets as much budget again. */
export function raiseAllowance(store: Store, runId: number): void {
  store.db.prepare("UPDATE automation_runs SET allowance = allowance + 1 WHERE id = ?").run(runId);
}

/** The run's agent is done (or its thread archived): its budget no longer applies. */
export function finishRun(store: Store, runId: number, at = new Date().toISOString()): void {
  store.db
    .prepare("UPDATE automation_runs SET finished_at = ? WHERE id = ? AND finished_at IS NULL")
    .run(at, runId);
}

// The scheduler.

/** What the scheduler asks of the engine. */
export interface AutomationHost {
  readonly store: Store;
  /** The project's config, read now (cached by its files' stamps). */
  config(root: string): ConfigRead;
  /** Starts a run's thread through the ordinary create, recording the run with it. */
  start(input: RunStart): Promise<ThreadView>;
  /** Where a run's thread is: still going, paused by its budget, finished, or archived. */
  state(threadId: ThreadId): NonNullable<AutomationRunView["state"]>;
  log(message: string): void;
}

export interface RunStart {
  project: Project;
  name: string;
  automation: Automation;
  trigger: "schedule" | "manual";
  title: string;
  prompt: string;
  budget: RunBudget | null;
}

export class Automations {
  readonly #host: AutomationHost;
  readonly #tickMs: number;
  readonly #timers = new Timers<"tick">();
  /** Automations a run is being started for, by project and name: a second one is skipped. */
  readonly #starting = new Set<string>();
  /** Fires in flight; `close` waits for them. */
  readonly #firing = new Set<Promise<unknown>>();
  #ticking = false;
  #closed = false;

  constructor(host: AutomationHost, options: { tickMs?: number } = {}) {
    this.#host = host;
    this.#tickMs = options.tickMs ?? TICK_MS;
  }

  /** Looks at the schedules now (a run missed while no daemon ran comes now, once), then on time. */
  start(): void {
    this.#closed = false;
    this.#arm(Date.now());
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#timers.clearAll();
    await Promise.allSettled([...this.#firing]);
  }

  /** Every project's automations, or one project's. */
  list(projectRef?: string): AutomationView[] {
    const projects = projectRef ? [findProject(this.#host.store, projectRef)] : listProjects(this.#host.store);
    return projects.flatMap((project) =>
      Object.entries(this.#definitions(project)).map(([name, automation]) =>
        this.#view(project, name, automation),
      ),
    );
  }

  /**
   * Runs an automation now, by hand: you have seen what it is, so its schedule (if it has one)
   * goes on for this definition from now. A run whose previous one is still going is skipped.
   */
  async run(
    projectRef: string,
    name: string,
  ): Promise<{ automation: AutomationView; run: AutomationRunView; thread: ThreadView | null }> {
    const project = findProject(this.#host.store, projectRef);
    const read = this.#host.config(project.path);
    if (read.problem !== null) {
      throw new TenzoError(`${project.name}'s Tenzo config is invalid, so its automations can't run: ${read.problem}`);
    }
    const automation = automationsOf(read)[name];
    if (!automation) {
      const names = Object.keys(automationsOf(read));
      throw new TenzoError(
        `${project.name} has no automation "${name.slice(0, 100)}"${names.length > 0 ? ` (it has ${names.join(", ")})` : " (.tenzo/config.json defines none)"}.`,
      );
    }
    const store = this.#host.store;
    const row = getRow(store, project.id, name) ?? { approved: null, scheduleKey: null, nextRunAt: null };
    saveRow(store, project.id, name, { ...row, approved: definitionHash(automation) });
    this.#sync(project, Date.now(), false);
    const { run, thread } = await this.#track(this.#fire(project, name, automation, "manual"));
    this.#arm(this.#nextDue());
    return { automation: this.#view(project, name, automation), run: this.#runView(run), thread };
  }

  /** One look at every schedule: fires what is due, then arms the next look. Public for tests. */
  async tick(): Promise<void> {
    if (this.#closed || this.#ticking) return;
    this.#ticking = true;
    try {
      const now = Date.now();
      for (const project of listProjects(this.#host.store)) {
        try {
          this.#sync(project, now, true);
        } catch (error) {
          this.#host.log(`couldn't look at ${project.name}'s automations: ${String(error)}`);
        }
      }
      this.#arm(this.#nextDue());
    } catch (error) {
      // The store is gone (the daemon stopping): nothing more to schedule.
      this.#host.log(`couldn't look at the automations: ${String(error)}`);
    } finally {
      this.#ticking = false;
    }
  }

  #arm(at: number): void {
    if (this.#closed) return;
    const soonest = Math.min(at, Date.now() + this.#tickMs);
    this.#timers.set("tick", soonest, () => void this.tick());
  }

  /** The earliest scheduled run of any automation. */
  #nextDue(): number {
    const row = this.#host.store.db
      .prepare("SELECT MIN(next_run_at) AS at FROM automations WHERE next_run_at IS NOT NULL")
      .get();
    return row?.at ? Date.parse(String(row.at)) : Number.POSITIVE_INFINITY;
  }

  #definitions(project: Project): Record<string, Automation> {
    try {
      return automationsOf(this.#host.config(project.path));
    } catch {
      return {};
    }
  }

  /**
   * Brings the project's schedules in step with its config: an automation whose schedule is on
   * (it has one, it isn't switched off, and you have run this definition by hand) gets its next
   * run worked out when that changed; one that is due fires (`fire`), once. A config that can't
   * be read changes nothing: its schedules wait for it to be fixed.
   */
  #sync(project: Project, now: number, fire: boolean): void {
    const read = this.#host.config(project.path);
    if (read.problem !== null) return;
    const store = this.#host.store;
    for (const [name, automation] of Object.entries(automationsOf(read))) {
      const row = getRow(store, project.id, name) ?? { approved: null, scheduleKey: null, nextRunAt: null };
      const scheduled = scheduleOf(automation);
      const on =
        scheduled !== null && automation.enabled !== false && row.approved === definitionHash(automation);
      const key = on ? scheduled.key : null;
      if (key !== row.scheduleKey) {
        const next = on ? nextRun(scheduled.schedule, scheduled.timeZone, now) : null;
        saveRow(store, project.id, name, {
          ...row,
          scheduleKey: key,
          nextRunAt: next === null ? null : new Date(next).toISOString(),
        });
        continue;
      }
      if (!on || !fire || row.nextRunAt === null || Date.parse(row.nextRunAt) > now) continue;
      // Due (or missed while no daemon ran): the next one is worked out before this one starts,
      // so it fires once whatever happens to the run.
      const next = nextAfterFiring(scheduled.schedule, scheduled.timeZone, Date.parse(row.nextRunAt), now);
      saveRow(store, project.id, name, { ...row, nextRunAt: next === null ? null : new Date(next).toISOString() });
      void this.#track(this.#fire(project, name, automation, "schedule"));
    }
  }

  #track<T>(firing: Promise<T>): Promise<T> {
    this.#firing.add(firing);
    void firing.finally(() => this.#firing.delete(firing)).catch(() => {});
    return firing;
  }

  /**
   * Starts a run: an ordinary thread on the automation's prompt, with its previous run's last
   * words and where its notes are. Skipped while its previous run is still going; failed (and
   * recorded so) when the thread can't be started.
   */
  async #fire(
    project: Project,
    name: string,
    automation: Automation,
    trigger: "schedule" | "manual",
  ): Promise<{ run: AutomationRun; thread: ThreadView | null }> {
    const store = this.#host.store;
    const key = `${project.id}/${name}`;
    const at = new Date().toISOString();
    const { started } = lastRuns(store, project.id, name);
    const previous = started[0];
    const record = (result: "skipped" | "failed", reason: string) => {
      const run = insertRun(store, {
        projectId: project.id,
        name,
        trigger,
        result,
        reason,
        threadId: null,
        at,
        budget: null,
      });
      this.#host.log(`automation ${project.name}/${name}: ${result}: ${reason}`);
      return { run, thread: null };
    };
    if (this.#starting.has(key)) return record("skipped", "A run of it was starting already.");
    const going = previous?.threadId ? this.#host.state(previous.threadId) : null;
    if (going === "going" || going === "paused") {
      return record(
        "skipped",
        `Its previous run (${previous?.threadId}) is still ${going === "paused" ? "paused by its budget" : "going"}.`,
      );
    }
    this.#starting.add(key);
    try {
      const prompt = runPrompt({
        name,
        automation,
        trigger: describeTrigger(automation),
        previous: previous?.threadId
          ? { at: previous.at, threadId: previous.threadId, summary: runSummary(store, previous.threadId) }
          : null,
        notes: await this.#notes(project, name, started),
      });
      const thread = await this.#host.start({
        project,
        name,
        automation,
        trigger,
        title: runTitle(name, Date.parse(at)),
        prompt,
        budget: budgetOf(automation),
      });
      const run = runOfThread(store, thread.id);
      if (!run) throw new Error(`the run of ${thread.id} wasn't recorded`);
      this.#host.log(`automation ${project.name}/${name}: started ${thread.id} (${trigger})`);
      return { run, thread };
    } catch (error) {
      return record("failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.#starting.delete(key);
    }
  }

  /** Where the newest notes are: on the default branch, on an earlier run's branch, or nowhere. */
  async #notes(
    project: Project,
    name: string,
    runs: readonly AutomationRun[],
  ): Promise<{ commit: string; onBase: boolean } | null> {
    try {
      const base = await resolveBase(project.path, project.defaultBranch);
      const refs = [base];
      for (const run of runs) {
        if (!run.threadId) continue;
        const branch = this.#branchOf(run.threadId);
        if (branch && (await branchExists(project.path, branch))) refs.push(`refs/heads/${branch}`);
      }
      return await latestChange(project.path, refs, base, notesPath(name));
    } catch (error) {
      this.#host.log(`couldn't look for ${project.name}/${name}'s notes: ${String(error)}`);
      return null;
    }
  }

  #branchOf(threadId: ThreadId): string | null {
    const row = this.#host.store.db.prepare("SELECT branch FROM threads WHERE id = ?").get(threadId);
    return row ? String(row.branch) : null;
  }

  #view(project: Project, name: string, automation: Automation): AutomationView {
    const row = getRow(this.#host.store, project.id, name);
    const { last } = lastRuns(this.#host.store, project.id, name);
    const scheduled = scheduleOf(automation);
    const firstLine = automation.prompt.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
    return {
      projectId: project.id,
      projectName: project.name,
      name,
      summary: cut(firstLine, 140),
      schedule: scheduled?.schedule.text ?? null,
      timeZone: scheduled?.timeZone ?? localTimeZone(),
      enabled: automation.enabled !== false,
      approved: row?.approved === definitionHash(automation),
      nextRunAt: row?.scheduleKey && row.scheduleKey === scheduled?.key ? row.nextRunAt : null,
      lastRun: last ? this.#runView(last) : null,
    };
  }

  #runView(run: AutomationRun): AutomationRunView {
    return {
      at: run.at,
      trigger: run.trigger,
      result: run.result,
      reason: run.reason,
      threadId: run.threadId,
      state: run.threadId ? this.#host.state(run.threadId) : null,
      costUsd: run.costUsd,
    };
  }
}

/** What to record for a run's thread when it starts: its automation, its own model choice. */
export function runThreadOptions(automation: Automation): { model?: string; thinking?: ThinkingLevel } {
  return {
    ...(automation.model ? { model: automation.model } : {}),
    ...(automation.thinking ? { thinking: automation.thinking } : {}),
  };
}
