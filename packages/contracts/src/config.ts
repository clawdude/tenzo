import { z } from "zod";

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
    /^[A-Za-z0-9._:@/[\]-]{1,100}$/,
    'must be a model name such as "sonnet" (letters, digits and . _ : @ / [ ] -, at most 100)',
  );

/** The model and thinking of one phase. */
export const PhaseModel = z.strictObject({
  model: ModelName.optional(),
  thinking: ThinkingLevel.optional(),
});
export type PhaseModel = z.infer<typeof PhaseModel>;

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
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
