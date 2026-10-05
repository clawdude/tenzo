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
   * Where a started run is: `going` (working, or waiting on you), `paused` (its budget ran out:
   * a card asks), `finished` (its agent is done), `archived`. Null for one that didn't start.
   */
  state: z.enum(["going", "paused", "finished", "archived"]).nullable(),
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
  /**
   * You have run this definition by hand. A schedule only starts runs of a definition you have
   * run yourself once: a new automation, or one whose prompt, trigger, budget or model changed
   * (a pull, a teammate's commit), waits for that before its schedule goes on.
   */
  approved: z.boolean(),
  /** When its schedule runs it next; null when nothing is scheduled. */
  nextRunAt: z.iso.datetime().nullable(),
  lastRun: AutomationRunView.nullable(),
});
export type AutomationView = z.infer<typeof AutomationView>;
