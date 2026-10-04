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
 * Claude Code's permission modes a project may set for its threads. Not `plan`: it stops every
 * tool from running, so nothing could ever be built (discussing is held by Tenzo's discuss
 * prompt and `propose`, not by a mode).
 */
export const PermissionModeName = z.enum([
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);
export type PermissionModeName = z.infer<typeof PermissionModeName>;

const ModelName = z.string().trim().min(1, "must name a model, e.g. \"sonnet\"");

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
