import { z } from "zod";
import { isTimeZone, parseSchedule } from "./schedule.ts";

/**
 * A project's own Tenzo settings (PRODUCT.md §8): `.tenzo/config.json`, committed, and
 * `.tenzo/local.json`, gitignored, for personal overrides. Both optional; the daemon reads them
 * from the project's main checkout and never writes them. Anything missing falls back to the
 * agent's own defaults.
 */

/**
 * How hard the agent thinks. `off`: no extended thinking. `low`, `medium`, `high`: Claude's
 * effort levels (as `/effort` sets them). Unset: the agent's own default (the user's settings).
 */
export const ThinkingLevel = z.enum(["off", "low", "medium", "high"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevel>;

/** Which landing the finished card offers as its filled button: Merge, or Open PR. */
export const LandingRule = z.enum(["merge", "pr"]);
export type LandingRule = z.infer<typeof LandingRule>;

/**
 * The permission modes a project's `.tenzo/` files may set for its threads: only what a file in
 * the repo could already get through Claude Code's own project settings (`acceptEdits`), or
 * less (`default`, `dontAsk`). Never `auto` or `bypassPermissions`: Claude Code itself refuses
 * those from repo-controllable settings, and Tenzo hands the mode to Claude as a trusted flag, so
 * taking them from the repo would get past that guard. They belong in your own
 * `~/.claude/settings.json` (`defaultMode`), which threads honour already. Not `plan` either: it
 * stops every tool, so nothing could be built.
 */
export const PermissionModeName = z.enum(["default", "acceptEdits", "dontAsk"]);
export type PermissionModeName = z.infer<typeof PermissionModeName>;

/** Modes a `.tenzo/` file may never set, and where they belong instead. */
export const USER_ONLY_MODES = ["auto", "bypassPermissions"] as const;

/**
 * A model name as Claude takes it: an alias (`sonnet`), an id (`claude-sonnet-5-5`), with a
 * context suffix (`opus[1m]`) or a provider's spelling (`us.anthropic.…:0`, `…@2025…`).
 */
export const ModelName = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,99}$/,
    'must be a model name such as "sonnet" (a letter or digit, then letters, digits and . _ : @ / [ ] -, at most 100)',
  );

/** The model and thinking of one phase. */
export const PhaseModel = z.strictObject({
  model: ModelName.optional(),
  thinking: ThinkingLevel.optional(),
});
export type PhaseModel = z.infer<typeof PhaseModel>;

/**
 * An automation's name: what `tenzo automation run <project> <name>` takes, its notes file's name
 * (`.tenzo/automations/<name>.md`), and its key in the config.
 */
export const AutomationName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "must be a name like review-prs (a-z, 0-9 and -, at most 40)");
export type AutomationName = z.infer<typeof AutomationName>;

/** How many automations one project may define. */
export const MAX_AUTOMATIONS = 20;
/** The longest an automation's prompt may be. */
export const MAX_AUTOMATION_PROMPT = 8_000;

const DURATION_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A duration as written in a config (`30m`, `2h`, `1d`) in ms, or null when it isn't one. */
export function durationMs(text: string): number | null {
  const match = /^(\d{1,5})(m|h|d)$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * (DURATION_UNITS[match[2] ?? ""] ?? 0);
}

/** A run's wall-clock budget: from a minute to a week. */
export const BudgetDuration = z.string().refine((text) => {
  const ms = durationMs(text);
  return ms !== null && ms >= 60_000 && ms <= 7 * 86_400_000;
}, 'must be a duration like "30m", "2h" or "1d", from 1m to 7d');

/**
 * When it runs by itself. No schedule: only when you run it (`tenzo automation run`, Run now).
 * See schedule.ts for the forms.
 */
export const AutomationTrigger = z.strictObject({
  schedule: z
    .string()
    .superRefine((text, ctx) => {
      const parsed = parseSchedule(text);
      if (typeof parsed === "string") ctx.addIssue({ code: "custom", message: parsed });
    })
    .optional(),
  /** The time zone its clock times are in (IANA, e.g. `Europe/Rome`). Default: the machine's. */
  timeZone: z
    .string()
    .refine(isTimeZone, 'must be a time zone this machine knows, like "Europe/Rome" or "UTC"')
    .optional(),
});
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

/**
 * What one run may use before it pauses and asks you (a quick-lane card: Continue with as much
 * again, or Stop). Never a kill.
 */
export const AutomationBudget = z.strictObject({
  /** From when the run starts until it finishes. */
  wallClock: BudgetDuration.optional(),
  /** What Claude reports the run's session spent, in USD (an estimate, as `/cost` shows). */
  costUsd: z.number().positive().max(1_000).optional(),
});
export type AutomationBudget = z.infer<typeof AutomationBudget>;

/**
 * One automation as a file states it (PRODUCT.md §7). Every key is optional here, so
 * `local.json` can override one key of an automation `config.json` defines (or switch its
 * schedule off with `enabled: false`); the merged one must have a prompt (`checkAutomations`).
 * A file in the repo writes it, so it may only start an ordinary thread: no permission mode,
 * nothing a thread you start yourself wouldn't get.
 */
export const AutomationConfig = z.strictObject({
  /** What the thread starts with. */
  prompt: z.string().max(MAX_AUTOMATION_PROMPT).optional(),
  trigger: AutomationTrigger.optional(),
  budget: AutomationBudget.optional(),
  /** The run's model and thinking in every phase, as a thread's own choice would be. */
  model: ModelName.optional(),
  thinking: ThinkingLevel.optional(),
  /** False: its schedule is off (running it by hand still works). Default true. */
  enabled: z.boolean().optional(),
});
export type AutomationConfig = z.infer<typeof AutomationConfig>;

/** An automation once both files are merged: it has a prompt. */
export type Automation = AutomationConfig & { prompt: string };

/**
 * The merged config's automations, each with a prompt, or what is wrong with them (naming the
 * automation).
 */
export function checkAutomations(config: ProjectConfig): Record<string, Automation> | string {
  const out: Record<string, Automation> = {};
  const all = Object.entries(config.automations ?? {});
  if (all.length > MAX_AUTOMATIONS) return `automations: at most ${MAX_AUTOMATIONS} automations`;
  for (const [name, automation] of all) {
    const prompt = automation.prompt?.trim() ?? "";
    if (prompt === "") return `automations.${name}.prompt: an automation needs a prompt`;
    out[name] = { ...automation, prompt };
  }
  return out;
}

export const ProjectConfig = z.strictObject({
  /** For an editor's JSON schema; Tenzo ignores it. */
  $schema: z.string().optional(),
  /** The agent threads run. Claude only, for now (Codex in M5). */
  agent: z.literal("claude").optional(),
  models: z
    .strictObject({
      /** While discussing: until Build it. */
      discuss: PhaseModel.optional(),
      /** From Build it on: building, review, landing. */
      build: PhaseModel.optional(),
      /**
       * Subagents' model, where a subagent doesn't name its own. Model only: a subagent's
       * thinking follows its own definition.
       */
      agents: z.strictObject({ model: ModelName.optional() }).optional(),
    })
    .optional(),
  /**
   * Overrides the permission mode in every phase. Absent: the user's own `defaultMode` (their
   * Claude settings) applies, as in their terminal.
   */
  permissions: PermissionModeName.optional(),
  /** The finished card's filled button. Default: merge. */
  landing: LandingRule.optional(),
  /** Saved thread recipes, by name: a prompt and when it runs by itself (PRODUCT.md §7). */
  automations: z
    .record(AutomationName, AutomationConfig)
    .refine((all) => Object.keys(all).length <= MAX_AUTOMATIONS, `at most ${MAX_AUTOMATIONS} automations`)
    .optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
