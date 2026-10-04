import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type LandingRule,
  type PermissionModeName,
  ProjectConfig,
  type ThinkingLevel,
} from "@tenzo/contracts";
import type { z } from "zod";

/**
 * A project's own Tenzo settings (PRODUCT.md §8): `.tenzo/config.json` (committed) and
 * `.tenzo/local.json` (gitignored, personal), both optional, read from the project's main
 * checkout and never written. local.json overrides config.json key by key (a deep merge). The
 * daemon reads them as each session starts, so an edit applies to the next session without a
 * restart; anything missing falls back to the agent's own defaults.
 *
 * An invalid file never stops a thread: it runs on the defaults, with an error card saying what
 * is wrong (`config.checked`, engine.ts).
 */
export const CONFIG_FILE = ".tenzo/config.json";
export const LOCAL_FILE = ".tenzo/local.json";

/** What reading a project's config found: the settings, or what is wrong with them. */
export type ConfigRead =
  | { config: ProjectConfig; problem: null }
  | { config: null; problem: string };

/** No config at all: everything is the agent's own default. */
export const NO_CONFIG: ConfigRead = { config: {}, problem: null };

/**
 * The two files' contents (undefined: the file isn't there) → the merged, checked config. Pure:
 * `readProjectConfig` does the reading.
 */
export function parseProjectConfig(files: { config?: string; local?: string }): ConfigRead {
  const committed = files.config === undefined ? {} : parseFile(CONFIG_FILE, files.config);
  if (typeof committed === "string") return { config: null, problem: committed };
  // A committed file is anyone's who can push to the repo: it may not turn every permission
  // prompt off on your machine. Your own local.json may.
  if (committed.permissions === "bypassPermissions") {
    return {
      config: null,
      problem: `${CONFIG_FILE}: permissions: bypassPermissions is only taken from ${LOCAL_FILE}, your own uncommitted file.`,
    };
  }
  const local = files.local === undefined ? {} : parseFile(LOCAL_FILE, files.local);
  if (typeof local === "string") return { config: null, problem: local };
  return { config: mergeConfig(committed, local), problem: null };
}

/** One file's settings, or what is wrong with it (naming the file and the key). */
function parseFile(name: string, text: string): ProjectConfig | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return `${name} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  const parsed = ProjectConfig.safeParse(json);
  if (parsed.success) return parsed.data;
  return `${name}: ${describeIssues(parsed.error.issues)}`;
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/** `over` on top of `base`, objects merged key by key, anything else replaced. */
export function mergeConfig(base: ProjectConfig, over: ProjectConfig): ProjectConfig {
  return mergeDeep(base, over) as ProjectConfig;
}

function mergeDeep(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = mergeDeep(base[key], value);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the project's config files from its main checkout `root`. */
export function readProjectConfig(root: string): ConfigRead {
  const files: { config?: string; local?: string } = {};
  for (const [key, name] of [
    ["config", CONFIG_FILE],
    ["local", LOCAL_FILE],
  ] as const) {
    try {
      const text = readText(join(root, name));
      if (text !== undefined) files[key] = text;
    } catch (error) {
      return { config: null, problem: `Can't read ${name}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return files.config === undefined && files.local === undefined ? NO_CONFIG : parseProjectConfig(files);
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * `readProjectConfig` for views, which ask often (every thread view carries the landing rule):
 * a project's files are read again only when one of them changed (size or time) or appeared.
 */
export class ProjectConfigs {
  readonly #cache = new Map<string, { stamp: string; read: ConfigRead }>();

  read(root: string): ConfigRead {
    const stamp = [CONFIG_FILE, LOCAL_FILE].map((name) => stampOf(join(root, name))).join("|");
    const cached = this.#cache.get(root);
    if (cached?.stamp === stamp) return cached.read;
    const read = readProjectConfig(root);
    this.#cache.set(root, { stamp, read });
    return read;
  }
}

function stampOf(path: string): string {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat ? `${stat.size}:${stat.mtimeMs}:${stat.ino}` : "-";
  } catch {
    return "?";
  }
}

/** The model and thinking level a session runs with; unset: the agent's own default. */
export interface ModelChoice {
  model?: string;
  thinking?: ThinkingLevel;
}

/**
 * What a thread's sessions run with: `discuss` until Build it, `build` from then on (building,
 * review, landing), and the subagents' model.
 */
export interface SessionModels {
  discuss: ModelChoice;
  build: ModelChoice;
  agents?: string;
}

/**
 * Tenzo's precedence, field by field: the thread's own choice (`thread.setModel`) over the
 * project's config over `TENZO_DEFAULT_MODEL` (models only) over the agent's own defaults.
 */
export function resolveModels(input: {
  thread: { model: string | null; thinking: ThinkingLevel | null };
  config: ProjectConfig | null;
  defaultModel?: string | undefined;
}): SessionModels {
  const models = input.config?.models;
  const choose = (
    phase: { model?: string | undefined; thinking?: ThinkingLevel | undefined } | undefined,
  ): ModelChoice => {
    const model = input.thread.model ?? phase?.model ?? input.defaultModel;
    const thinking = input.thread.thinking ?? phase?.thinking;
    return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
  };
  return {
    discuss: choose(models?.discuss),
    build: choose(models?.build),
    ...(models?.agents?.model ? { agents: models.agents.model } : {}),
  };
}

/** The finished card's filled button: the config's landing rule, Merge without one. */
export function landingOf(read: ConfigRead): LandingRule {
  return read.config?.landing ?? "merge";
}

/** The permission mode the config sets, or none: the user's own `defaultMode` applies. */
export function permissionsOf(read: ConfigRead): PermissionModeName | undefined {
  return read.config?.permissions;
}
