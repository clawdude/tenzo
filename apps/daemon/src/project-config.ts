import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { join, sep } from "node:path";
import {
  type Automation,
  checkAutomations,
  type LandingRule,
  type PermissionModeName,
  ProjectConfig,
  type ThinkingLevel,
  USER_ONLY_MODES,
} from "@tenzo/contracts";
import type { z } from "zod";

/**
 * A project's own Tenzo settings (PRODUCT.md §8): `.tenzo/config.json` (committed) and
 * `.tenzo/local.json` (personal), both optional, read from the project's main checkout and never
 * written. local.json overrides config.json key by key (a deep merge). The daemon reads them
 * before each turn (engine.ts), so an edit applies without a restart; anything missing falls
 * back to the agent's own defaults.
 *
 * Both files live in the repo, so both are treated as the repo's, never as the user's own: what
 * they may set is limited to what the repo could already get through Claude Code's own project
 * settings (see `PermissionModeName`), and they are read only as plain files inside the repo, of
 * a config's size. An invalid file never stops a thread: it runs on the defaults, with an error
 * card saying what is wrong (`config.checked`, engine.ts).
 */
export const CONFIG_FILE = ".tenzo/config.json";
export const LOCAL_FILE = ".tenzo/local.json";
const CONFIG_DIR = ".tenzo";

/** A config file larger than this isn't read. */
export const MAX_CONFIG_BYTES = 64 * 1024;

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
  const local = files.local === undefined ? {} : parseFile(LOCAL_FILE, files.local);
  if (typeof local === "string") return { config: null, problem: local };
  const merged = mergeConfig(committed, local);
  // local.json may override part of an automation; the merged one must be whole.
  const automations = checkAutomations(merged);
  if (typeof automations === "string") return { config: null, problem: automations };
  return { config: merged, problem: null };
}

/** The config's automations, each with its prompt; none when the config can't be read. */
export function automationsOf(read: ConfigRead): Record<string, Automation> {
  if (!read.config) return {};
  const automations = checkAutomations(read.config);
  return typeof automations === "string" ? {} : automations;
}

/** One file's settings, or what is wrong with it (naming the file and the key). */
function parseFile(name: string, text: string): ProjectConfig | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return `${name} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  const mode = isPlainObject(json) ? json.permissions : undefined;
  if ((USER_ONLY_MODES as readonly unknown[]).includes(mode)) {
    return `${name}: permissions: "${String(mode)}" is never taken from a file in the repo (Claude Code refuses it from project settings too). Set it as defaultMode in your own ~/.claude/settings.json: threads use that already.`;
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

/** Why a config file wasn't read: said on the card as it is. */
class Unreadable extends Error {}

/** Reads the project's config files from its main checkout `root`. */
export function readProjectConfig(root: string): ConfigRead {
  const files: { config?: string; local?: string } = {};
  for (const [key, name] of [
    ["config", CONFIG_FILE],
    ["local", LOCAL_FILE],
  ] as const) {
    try {
      const text = readConfigFile(root, name);
      if (text !== undefined) files[key] = text;
    } catch (error) {
      const why = error instanceof Unreadable ? error.message : `Can't read ${name}: ${String(error)}`;
      return { config: null, problem: why };
    }
  }
  return files.config === undefined && files.local === undefined ? NO_CONFIG : parseProjectConfig(files);
}

/**
 * A config file's text, or undefined when there is none. Only a plain file inside the repo, of a
 * config's size: never a link (a repo can commit one to `/dev/zero` or to a file of yours), a
 * device, a pipe or a folder, so reading can neither hang the daemon nor show what is outside.
 */
function readConfigFile(root: string, name: string): string | undefined {
  const dir = lstatSync(join(root, CONFIG_DIR), { throwIfNoEntry: false });
  if (!dir) return undefined;
  if (!dir.isDirectory()) {
    throw new Unreadable(`${CONFIG_DIR} must be a folder in the repo, not a link or a file; Tenzo didn't read it.`);
  }
  const path = join(root, name);
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (!file) return undefined;
  checkPlain(name, file);
  const real = realpathSync(path);
  if (!real.startsWith(realpathSync(root) + sep)) {
    throw new Unreadable(`${name} isn't inside the repo; Tenzo didn't read it.`);
  }
  // Not following a link and not waiting on a pipe, in case it changed since the lstat; what was
  // opened is checked again before a byte is read.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    checkPlain(name, fstatSync(fd));
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > MAX_CONFIG_BYTES) throw tooBig(name);
    return buffer.subarray(0, size).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function checkPlain(name: string, stat: Stats): void {
  if (!stat.isFile()) {
    throw new Unreadable(
      `${name} must be a plain file in the repo, not a link, folder or device; Tenzo didn't read it.`,
    );
  }
  if (stat.size > MAX_CONFIG_BYTES) throw tooBig(name);
}

function tooBig(name: string): Unreadable {
  return new Unreadable(`${name} is larger than ${MAX_CONFIG_BYTES / 1024} KB, too large for a config; Tenzo didn't read it.`);
}

/**
 * `readProjectConfig` for the daemon, which asks often (every thread view carries the landing
 * rule, every turn checks the models): the files are read again only when the folder or one of
 * them changed (an lstat each: links aren't followed), else the last read is the answer.
 */
export class ProjectConfigs {
  readonly #cache = new Map<string, { stamp: string; read: ConfigRead }>();

  read(root: string): ConfigRead {
    const stamp = [CONFIG_DIR, CONFIG_FILE, LOCAL_FILE].map((name) => stampOf(join(root, name))).join("|");
    const cached = this.#cache.get(root);
    if (cached?.stamp === stamp) return cached.read;
    const read = readProjectConfig(root);
    this.#cache.set(root, { stamp, read });
    return read;
  }
}

function stampOf(path: string): string {
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false, bigint: true });
    return stat ? `${stat.mode}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "-";
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
