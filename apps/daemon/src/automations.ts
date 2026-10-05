import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Automation,
  type AutomationProblem,
  type AutomationRunView,
  type AutomationsState,
  type AutomationView,
  durationMs,
  localTimeZone,
  MIN_SCHEDULE_GAP_MS,
  nextRun,
  parseSchedule,
  type ProjectId,
  RUN_BUDGET,
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
 * missed time) and every run (started, skipped, failed), with a started run's budget and what it
 * has used. Budgets are the engine's to watch (it sees the turns); this module starts the runs.
 *
 * A file in the repo defines an automation, so it only ever starts an ordinary thread, with your
 * own permissions and nothing more, and within bounds the repo can't move: every run has a
 * budget (1h and $2 unless the file says otherwise, at most 24h and $20), an automation's
 * schedule starts a run at most every 5 minutes, at most 3 runs go at once across all projects,
 * and an off switch in Tenzo's home (`tenzo automation pause`) stops every schedule.
 */

/** What one grant of a run's budget is: wall clock from when it is given, and spend. */
export interface RunBudget {
  wallClockMs: number;
  costUsd: number;
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
  /** One grant's worth: what the run started with, and what each Continue adds. */
  budget: RunBudget | null;
  /** The run is paused once the clock passes this (ms since the epoch). */
  deadline: number | null;
  /** The run is paused once Claude's running total reaches this (USD). */
  capUsd: number | null;
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

/** The scheduler never looks again sooner than this: no schedule can make it spin. */
export const MIN_TICK_MS = 1_000;

/** Automation runs that may be going at once, across every project, for schedules to start more. */
export const MAX_RUNS_GOING = 3;

/** How long the notes lookup's `git log` may take. */
const NOTES_TIMEOUT_MS = 10_000;

/** The off switch's file, in Tenzo's home: never in a repo, so a repo can't turn it off. */
export const PAUSED_FILE = "automations.paused";

/** The notes file an automation's runs keep for each other, in the repo. */
export function notesPath(name: string): string {
  return `.tenzo/automations/${name}.md`;
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
 * When a schedule comes next after it came at `scheduledAt` and fired at `now`: at least
 * `MIN_SCHEDULE_GAP_MS` after `now`, whatever the schedule says. An interval counts from when it
 * was due, unless that has passed too (the daemon was down): then from now. Missed times never
 * pile up: whatever was missed ran once, now.
 */
export function nextAfterFiring(
  schedule: Schedule,
  timeZone: string,
  scheduledAt: number,
  now: number,
): number | null {
  const earliest = now + MIN_SCHEDULE_GAP_MS;
  if (schedule.kind === "every") {
    const due = scheduledAt + schedule.ms;
    return Math.max(due > now ? due : now + schedule.ms, earliest);
  }
  return nextRun(schedule, timeZone, earliest - 1);
}

/** The budget one grant gives, from the definition, its defaults filled in. */
export function budgetOf(automation: Automation): RunBudget {
  const wallClock = automation.budget?.wallClock ? durationMs(automation.budget.wallClock) : null;
  return {
    wallClockMs: wallClock ?? RUN_BUDGET.defaultWallClockMs,
    costUsd: automation.budget?.costUsd ?? RUN_BUDGET.defaultCostUsd,
  };
}

/** "every 1h", "daily 09:00 (Europe/Rome)", or "run by hand" for one without a schedule. */
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
 * the agent may, without proposing first (only that file: everything else follows the thread's
 * usual flow), and commits it on its branch, where the next run is pointed to it.
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
    `Notes: \`${path}\` is this automation's notes file, what one run leaves for the next (what you did, where you left off). ${where}`,
    `Before you end, update it if something is worth keeping and commit it (that file alone) to this thread's branch; the next run is pointed to it. Writing and committing this one file needs no proposal and no agreement first; any other change still does.`,
    "Also leave markers in the systems you work in (a comment, a label) so a later run can tell what's done.",
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
  scheduleKey: string | null;
  nextRunAt: string | null;
}

const NO_ROW: AutomationRow = { scheduleKey: null, nextRunAt: null };

function getRow(store: Store, projectId: ProjectId, name: string): AutomationRow | undefined {
  const row = store.db
    .prepare("SELECT schedule_key, next_run_at FROM automations WHERE project_id = ? AND name = ?")
    .get(projectId, name);
  if (!row) return undefined;
  return {
    scheduleKey: row.schedule_key === null ? null : String(row.schedule_key),
    nextRunAt: row.next_run_at === null ? null : String(row.next_run_at),
  };
}

function saveRow(store: Store, projectId: ProjectId, name: string, row: AutomationRow): void {
  store.db
    .prepare(
      `INSERT INTO automations (project_id, name, environment_id, schedule_key, next_run_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, name) DO UPDATE SET
         schedule_key = excluded.schedule_key, next_run_at = excluded.next_run_at`,
    )
    .run(projectId, name, store.environmentId, row.scheduleKey, row.nextRunAt);
}

/**
 * Forgets the schedules of automations no config defines any more: the project's that aren't
 * in `names`, or (no `projectId`) every removed project's. They are never armed again.
 */
function dropSchedules(store: Store, projectId: ProjectId | null, names: readonly string[] = []): void {
  if (projectId === null) {
    store.db
      .prepare(
        `UPDATE automations SET schedule_key = NULL, next_run_at = NULL
         WHERE next_run_at IS NOT NULL
           AND project_id NOT IN (SELECT id FROM projects WHERE removed_at IS NULL)`,
      )
      .run();
    return;
  }
  store.db
    .prepare(
      `UPDATE automations SET schedule_key = NULL, next_run_at = NULL
       WHERE project_id = ? AND next_run_at IS NOT NULL
         AND name NOT IN (SELECT value FROM json_each(?))`,
    )
    .run(projectId, JSON.stringify(names));
}

/** Records a run; keeps the last `KEEP_EMPTY_RUNS` that started nothing. */
export function insertRun(
  store: Store,
  run: Omit<AutomationRun, "id" | "deadline" | "capUsd" | "costUsd" | "finishedAt">,
): AutomationRun {
  const deadline = run.budget ? Date.parse(run.at) + run.budget.wallClockMs : null;
  const capUsd = run.budget ? run.budget.costUsd : null;
  const { lastInsertRowid } = store.db
    .prepare(
      `INSERT INTO automation_runs
         (environment_id, project_id, name, trigger, result, reason, thread_id, at, budget,
          deadline_at, cap_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      deadline === null ? null : new Date(deadline).toISOString(),
      capUsd,
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
  return { ...run, id: Number(lastInsertRowid), deadline, capUsd, costUsd: null, finishedAt: null };
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
    deadline: row.deadline_at === null ? null : Date.parse(String(row.deadline_at)),
    capUsd: row.cap_usd === null ? null : Number(row.cap_usd),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

/** The run a thread is, if it is one. */
export function runOfThread(store: Store, threadId: ThreadId): AutomationRun | undefined {
  const row = store.db.prepare("SELECT * FROM automation_runs WHERE thread_id = ?").get(threadId);
  return row ? toRun(row) : undefined;
}

/** The automation's latest run, and its latest runs that started a thread. */
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

/** When the automation's schedule last started a run (ms), if it ever did. */
function lastScheduledStart(store: Store, projectId: ProjectId, name: string): number | null {
  const row = store.db
    .prepare(
      `SELECT MAX(at) AS at FROM automation_runs
       WHERE project_id = ? AND name = ? AND trigger = 'schedule' AND result = 'started'`,
    )
    .get(projectId, name);
  return row?.at ? Date.parse(String(row.at)) : null;
}

/** Threads of automation runs that aren't archived: the ones that may still be going. */
export function activeRunThreads(store: Store): ThreadId[] {
  return store.db
    .prepare(
      `SELECT r.thread_id AS id FROM automation_runs r JOIN threads t ON t.id = r.thread_id
       WHERE t.status = 'active'`,
    )
    .all()
    .map((row) => String(row.id) as ThreadId);
}

/** The automation's runs whose thread isn't archived, oldest first. */
export function activeRunsOf(store: Store, projectId: ProjectId, name: string): ThreadId[] {
  return store.db
    .prepare(
      `SELECT r.thread_id AS id FROM automation_runs r JOIN threads t ON t.id = r.thread_id
       WHERE r.project_id = ? AND r.name = ? AND t.status = 'active' ORDER BY r.id`,
    )
    .all(projectId, name)
    .map((row) => String(row.id) as ThreadId);
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

/**
 * Claude's running total for the run, kept at its highest (a crashed turn may report 0). A
 * resumed session carries on from the total its transcript saved (Claude restores it), so the
 * highest is the run's whole spend; if a session ended before saving it, the next one would start
 * lower and this undercounts by what that one spent after its last save. Claude's own cap
 * (`maxBudgetUsd`, what is left of `cap_usd`) still holds within each session.
 */
export function recordCost(store: Store, runId: number, costUsd: number): void {
  if (!Number.isFinite(costUsd) || costUsd < 0) return;
  store.db
    .prepare("UPDATE automation_runs SET cost_usd = MAX(COALESCE(cost_usd, 0), ?) WHERE id = ?")
    .run(costUsd, runId);
}

/**
 * Continue on a budget card: a fresh grant from now. The wall clock runs one grant from now
 * (time paused or waiting on you doesn't count against it), and the spend cap is one grant above
 * what is spent already or the old cap, whichever is higher (one API call can go past a cap).
 */
export function grantMore(store: Store, run: AutomationRun, now = Date.now()): void {
  if (!run.budget) return;
  const deadline = now + run.budget.wallClockMs;
  const capUsd = Math.max(run.costUsd ?? 0, run.capUsd ?? 0) + run.budget.costUsd;
  store.db
    .prepare("UPDATE automation_runs SET deadline_at = ?, cap_usd = ? WHERE id = ?")
    .run(new Date(deadline).toISOString(), capUsd, run.id);
}

/** The run's agent is done (or its thread archived): its budget no longer applies. */
export function finishRun(store: Store, runId: number, at = new Date().toISOString()): void {
  store.db
    .prepare("UPDATE automation_runs SET finished_at = ? WHERE id = ? AND finished_at IS NULL")
    .run(at, runId);
}

// The scheduler.

/** Where a run's thread is (`AutomationRunView.state`, never null here). */
export type RunState = NonNullable<AutomationRunView["state"]>;

/** What the scheduler asks of the engine. */
export interface AutomationHost {
  readonly store: Store;
  /** The project's config, read now (cached by its files' stamps). */
  config(root: string): ConfigRead;
  /** Starts a run's thread through the ordinary create, recording the run with it. */
  start(input: RunStart): Promise<ThreadView>;
  /** Where a run's thread is. */
  state(threadId: ThreadId): RunState;
  /**
   * Whether a run's worktree was clean when last looked at (true when not looked at yet): a
   * finished run with uncommitted changes is never archived, so it isn't offered.
   */
  clean(threadId: ThreadId): boolean;
  /**
   * Archives a finished run's thread when nothing would be lost (no open item, a clean
   * worktree, no commits beyond its base); its branch is kept. Says whether it did.
   */
  retire(threadId: ThreadId): Promise<boolean>;
  /** Something a list of automations shows may have changed (a run, a schedule, the switch). */
  changed(): void;
  log(message: string): void;
}

export interface RunStart {
  project: Project;
  name: string;
  automation: Automation;
  trigger: "schedule" | "manual";
  title: string;
  prompt: string;
  budget: RunBudget;
}

export class Automations {
  readonly #host: AutomationHost;
  readonly #tickMs: number;
  readonly #pausedFile: string;
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
    this.#pausedFile = join(host.store.home, PAUSED_FILE);
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

  /** The off switch is on: no schedule starts a run. */
  get paused(): boolean {
    return existsSync(this.#pausedFile);
  }

  /** Turns the off switch on or off. Kept in Tenzo's home, so it outlives the daemon. */
  setPaused(paused: boolean): boolean {
    if (paused) writeFileSync(this.#pausedFile, `${new Date().toISOString()}\n`);
    else rmSync(this.#pausedFile, { force: true });
    if (!paused) this.#arm(Date.now());
    this.#host.changed();
    return this.paused;
  }

  /** Every automation, the off switch, and the projects whose config can't be read. */
  state(): AutomationsState {
    return { automations: this.list(), paused: this.paused, problems: this.problems() };
  }

  /** The projects whose config can't be read, so none of their automations run, and why. */
  problems(projectRef?: string): AutomationProblem[] {
    const projects = projectRef ? [findProject(this.#host.store, projectRef)] : listProjects(this.#host.store);
    return projects.flatMap((project) => {
      const { problem } = this.#host.config(project.path);
      return problem === null ? [] : [{ projectId: project.id, projectName: project.name, problem }];
    });
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

  /** Runs an automation now, by hand. A run whose previous one is still going is skipped. */
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
    const { run, thread } = await this.#track(this.#fire(project, name, automation, "manual"));
    return { automation: this.#view(project, name, automation), run: this.#runView(run), thread };
  }

  /** One look at every schedule: fires what is due, then arms the next look. Public for tests. */
  async tick(): Promise<void> {
    if (this.#closed || this.#ticking) return;
    this.#ticking = true;
    try {
      const now = Date.now();
      const upcoming: number[] = [];
      for (const project of listProjects(this.#host.store)) {
        try {
          upcoming.push(...this.#sync(project, now));
        } catch (error) {
          this.#host.log(`couldn't look at ${project.name}'s automations: ${String(error)}`);
        }
      }
      dropSchedules(this.#host.store, null);
      // Only what this look saw is armed: a stale time (a deleted automation, a broken config,
      // a removed project) can't bring the next look forward.
      this.#arm(Math.min(...upcoming));
      this.#host.changed();
    } catch (error) {
      // The store is gone (the daemon stopping): nothing more to schedule.
      this.#host.log(`couldn't look at the automations: ${String(error)}`);
    } finally {
      this.#ticking = false;
    }
  }

  /** The next look: at `at`, within `tickMs` (configs change), never sooner than `MIN_TICK_MS`. */
  #arm(at: number): void {
    if (this.#closed) return;
    const now = Date.now();
    const next = Math.max(Math.min(at, now + this.#tickMs), now + MIN_TICK_MS);
    this.#timers.set("tick", next, () => void this.tick());
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
   * (it has one and it isn't switched off) gets its next run worked out when that changed; one
   * that is due fires (`fire`), once. Says when the next ones are. A config that can't be read
   * changes nothing and arms nothing: its schedules wait for it to be fixed.
   */
  #sync(project: Project, now: number): number[] {
    const read = this.#host.config(project.path);
    if (read.problem !== null) return [];
    const store = this.#host.store;
    const automations = automationsOf(read);
    dropSchedules(store, project.id, Object.keys(automations));
    const upcoming: number[] = [];
    const save = (name: string, row: AutomationRow, next: number | null) => {
      saveRow(store, project.id, name, { ...row, nextRunAt: next === null ? null : new Date(next).toISOString() });
      if (next !== null) upcoming.push(next);
    };
    for (const [name, automation] of Object.entries(automations)) {
      const row = getRow(store, project.id, name) ?? NO_ROW;
      const scheduled = scheduleOf(automation);
      const on = scheduled !== null && automation.enabled !== false;
      const key = on ? scheduled.key : null;
      if (key !== row.scheduleKey) {
        save(name, { ...row, scheduleKey: key }, on ? nextRun(scheduled.schedule, scheduled.timeZone, now) : null);
        continue;
      }
      if (!on || row.nextRunAt === null) continue;
      const due = Date.parse(row.nextRunAt);
      if (due > now) {
        upcoming.push(due);
        continue;
      }
      // Due (or missed while no daemon ran). The next one is worked out before this one
      // starts, so it fires once whatever happens to the run.
      const last = lastScheduledStart(store, project.id, name);
      if (last !== null && now - last < MIN_SCHEDULE_GAP_MS) {
        // Too soon after the last one (a cron line every minute): at the gap's end instead.
        save(name, row, Math.max(nextRun(scheduled.schedule, scheduled.timeZone, last + MIN_SCHEDULE_GAP_MS - 1) ?? 0, last + MIN_SCHEDULE_GAP_MS));
        continue;
      }
      save(name, row, nextAfterFiring(scheduled.schedule, scheduled.timeZone, due, now));
      void this.#track(this.#fire(project, name, automation, "schedule"));
    }
    return upcoming;
  }

  #track<T>(firing: Promise<T>): Promise<T> {
    this.#firing.add(firing);
    void firing.finally(() => this.#firing.delete(firing)).catch(() => {});
    return firing;
  }

  /** Why a scheduled run may not start now, if it may not: the off switch, or too many going. */
  #held(): string | null {
    if (this.paused) return "Automations are paused (`tenzo automation resume` turns them back on).";
    const going = activeRunThreads(this.#host.store).filter((id) => {
      const state = this.#host.state(id);
      return state !== "finished" && state !== "archived";
    }).length;
    if (going + this.#starting.size >= MAX_RUNS_GOING) {
      return `Too many automation runs going (${MAX_RUNS_GOING} at once at most, across all projects).`;
    }
    return null;
  }

  /**
   * Starts a run: an ordinary thread on the automation's prompt, with its previous run's last
   * words and where its notes are. Skipped while its previous run is still going (and, for a
   * schedule, while automations are paused or too many runs are going); failed (and recorded so)
   * when the thread can't be started. A previous run that finished with nothing to keep is
   * archived first (its branch stays).
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
      this.#host.changed();
      return { run, thread: null };
    };
    if (this.#starting.has(key)) return record("skipped", "A run of it was starting already.");
    const state = previous?.threadId ? this.#host.state(previous.threadId) : null;
    if (state === "going" || state === "waiting" || state === "paused") {
      const why = { going: "is still going", waiting: "is waiting on you", paused: "is paused by its budget" }[state];
      return record("skipped", `Its previous run (${previous?.threadId}) ${why}.`);
    }
    if (trigger === "schedule") {
      const held = this.#held();
      if (held) return record("skipped", held);
    }
    this.#starting.add(key);
    try {
      if (previous?.threadId && state === "finished") {
        try {
          if (await this.#host.retire(previous.threadId)) {
            this.#host.log(`automation ${project.name}/${name}: archived its finished run ${previous.threadId}`);
          }
        } catch (error) {
          this.#host.log(`couldn't archive ${previous.threadId}: ${String(error)}`);
        }
      }
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
      this.#host.changed();
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
      return await latestChange(project.path, refs, base, notesPath(name), NOTES_TIMEOUT_MS);
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
      budget: budgetOf(automation),
      model: automation.model ?? null,
      nextRunAt: row?.scheduleKey && row.scheduleKey === scheduled?.key ? row.nextRunAt : null,
      lastRun: last ? this.#runView(last) : null,
      finishedRuns: activeRunsOf(this.#host.store, project.id, name).filter(
        (id) => this.#host.state(id) === "finished" && this.#host.clean(id),
      ).length,
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

/** What to record for a run's thread when it starts: its own model choice. */
export function runThreadOptions(automation: Automation): { model?: string; thinking?: ThinkingLevel } {
  return {
    ...(automation.model ? { model: automation.model } : {}),
    ...(automation.thinking ? { thinking: automation.thinking } : {}),
  };
}

/**
 * What `tenzo project add` says about the project's automations: how many its config runs on a
 * schedule (they start by themselves once the daemon sees the project), each with its schedule;
 * or that its config can't be read. Null when there is nothing to say.
 */
export function scheduledNote(read: ConfigRead, machineZone = localTimeZone()): string | null {
  if (read.problem !== null) {
    return `Its Tenzo config can't be read, so its automations won't run: ${read.problem}`;
  }
  const scheduled = Object.entries(automationsOf(read)).filter(
    ([, automation]) => automation.enabled !== false && scheduleOf(automation, machineZone) !== null,
  );
  if (scheduled.length === 0) return null;
  const one = scheduled.length === 1;
  return [
    one
      ? "1 automation will run on schedule; `tenzo automation pause` stops it."
      : `${scheduled.length} automations will run on schedule; \`tenzo automation pause\` stops them.`,
    ...scheduled.map(([name, automation]) => `  ${name}: ${describeTrigger(automation, machineZone)}`),
  ].join("\n");
}
