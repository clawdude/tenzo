import { z } from "zod";
import { ProjectId, ThreadId } from "./ids.ts";

/**
 * Automations as clients see them (PRODUCT.md §7): each one a project's `.tenzo/config.json`
 * defines, with when it runs next and how its last run went. The definitions themselves stay in
 * the project's files; the daemon keeps only its schedule and its runs.
 */

/**
 * One time an automation fired. `started`: a thread is running it (`threadId`). `skipped`: its
 * previous run was still going, so this one didn't start. `failed`: the thread couldn't be
 * started (`reason` says why).
 */
export const AutomationRunView = z.object({
  at: z.iso.datetime(),
  /** Its schedule came, or you ran it (`automation.run`). */
  trigger: z.enum(["schedule", "manual"]),
  result: z.enum(["started", "skipped", "failed"]),
  reason: z.string().nullable(),
  threadId: ThreadId.nullable(),
  /**
   * Where a started run is: `going` (working, or landing), `waiting` (on you: a question, a
   * permission, a proposal, an error card), `paused` (its budget ran out: a card asks),
   * `finished` (its agent is done), `archived`. Null for one that didn't start.
   */
  state: z.enum(["going", "waiting", "paused", "finished", "archived"]).nullable(),
  /** What its session spent so far, as Claude reports it (USD); null before its first turn ends. */
  costUsd: z.number().nullable(),
});
export type AutomationRunView = z.infer<typeof AutomationRunView>;

export const AutomationView = z.object({
  projectId: ProjectId,
  projectName: z.string(),
  name: z.string(),
  /** The prompt's first line, cut to size: what it does, for a list. */
  summary: z.string(),
  /** Its schedule as written, or null: it runs only when you run it. */
  schedule: z.string().nullable(),
  /** The time zone the schedule's clock times are in. */
  timeZone: z.string(),
  /** False when `enabled: false` switched its schedule off. */
  enabled: z.boolean(),
  /** What one run may use before it pauses and asks, its defaults filled in. */
  budget: z.object({ wallClockMs: z.number(), costUsd: z.number() }),
  /** The run's own model, when the definition names one. */
  model: z.string().nullable(),
  /** When its schedule runs it next; null when nothing is scheduled. */
  nextRunAt: z.iso.datetime().nullable(),
  lastRun: AutomationRunView.nullable(),
  /**
   * Its runs that are finished (`AutomationRunView.state`) and not archived yet: what
   * `automation.archiveFinished` would look at.
   */
  finishedRuns: z.number().int().nonnegative().default(0),
});
export type AutomationView = z.infer<typeof AutomationView>;

/**
 * A project whose `.tenzo/config.json` (or `local.json`) can't be read: none of its automations
 * run, by schedule or by hand, until it is fixed. `problem` says what is wrong.
 */
export const AutomationProblem = z.object({
  projectId: ProjectId,
  projectName: z.string(),
  problem: z.string(),
});
export type AutomationProblem = z.infer<typeof AutomationProblem>;

/** Everything a list of automations draws: each one, the off switch, and broken configs. */
export const AutomationsState = z.object({
  automations: z.array(AutomationView),
  /** The off switch (`automation.pause`): no schedule starts a run while it is on. */
  paused: z.boolean(),
  problems: z.array(AutomationProblem).default([]),
});
export type AutomationsState = z.infer<typeof AutomationsState>;
