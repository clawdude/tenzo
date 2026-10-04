import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  landingOf,
  MAX_CONFIG_BYTES,
  mergeConfig,
  NO_CONFIG,
  parseProjectConfig,
  permissionsOf,
  ProjectConfigs,
  readProjectConfig,
  resolveModels,
} from "./project-config.ts";
import { initRepo, removeTempDirs, sh, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

const json = (value: unknown) => JSON.stringify(value);

describe("project config: parsing and merging", () => {
  it("takes PRODUCT.md's example as it is", () => {
    const read = parseProjectConfig({
      config: json({
        agent: "claude",
        models: {
          discuss: { model: "opus", thinking: "high" },
          build: { model: "sonnet", thinking: "medium" },
          agents: { model: "haiku" },
        },
        landing: "pr",
      }),
    });
    expect(read.problem).toBeNull();
    expect(read.config?.models?.build).toEqual({ model: "sonnet", thinking: "medium" });
    expect(landingOf(read)).toBe("pr");
    expect(permissionsOf(read)).toBeUndefined();
  });

  it("has nothing to say without files: every default is the agent's", () => {
    expect(parseProjectConfig({})).toEqual(NO_CONFIG);
    expect(landingOf(NO_CONFIG)).toBe("merge");
    expect(permissionsOf(NO_CONFIG)).toBeUndefined();
  });

  it("lets local.json override config.json key by key", () => {
    const read = parseProjectConfig({
      config: json({
        models: { discuss: { model: "opus", thinking: "high" }, build: { model: "sonnet" } },
        landing: "pr",
      }),
      local: json({ models: { discuss: { model: "haiku" } }, landing: "merge", permissions: "acceptEdits" }),
    });
    expect(read.config).toEqual({
      models: { discuss: { model: "haiku", thinking: "high" }, build: { model: "sonnet" } },
      landing: "merge",
      permissions: "acceptEdits",
    });
    // local.json alone is enough.
    expect(parseProjectConfig({ local: json({ landing: "pr" }) }).config).toEqual({ landing: "pr" });
  });

  it("merges objects deeply and replaces anything else", () => {
    expect(mergeConfig({ models: { build: { model: "a", thinking: "low" } } }, { models: { build: { thinking: "off" } } })).toEqual({
      models: { build: { model: "a", thinking: "off" } },
    });
  });

  it.each([
    [{ config: "{ nope" }, /^\.tenzo\/config\.json isn't valid JSON/],
    [{ local: "[1," }, /^\.tenzo\/local\.json isn't valid JSON/],
    [{ config: json({ models: { build: { thinking: "max" } } }) }, /^\.tenzo\/config\.json: models\.build\.thinking: .*"off"\|"low"\|"medium"\|"high"/],
    [{ config: json({ modles: {} }) }, /^\.tenzo\/config\.json: .*modles/],
    [{ config: json({ agent: "codex" }) }, /^\.tenzo\/config\.json: agent: /],
    [{ config: json({ models: { agents: { thinking: "high" } } }) }, /models\.agents: .*thinking/],
    [{ config: json({ models: { discuss: { model: "" } } }) }, /models\.discuss\.model: must be a model name/],
    [{ config: json({ models: { build: { model: "--dangerously-skip-permissions x" } } }) }, /models\.build\.model: must be a model name/],
    [{ config: json({ models: { agents: { model: "x".repeat(101) } } }) }, /models\.agents\.model: must be a model name/],
    [{ config: json({ permissions: "plan" }) }, /permissions: /],
    [{ config: json({ landing: "squash" }) }, /landing: /],
    [{ config: json([]) }, /^\.tenzo\/config\.json: /],
    [{ local: json({ landing: 1 }) }, /^\.tenzo\/local\.json: landing: /],
  ])("says clearly what is wrong with %j", (files, problem) => {
    const read = parseProjectConfig(files);
    expect(read.config).toBeNull();
    expect(read.problem).toMatch(problem);
  });

  // Both files live in the repo: neither may grant what Claude Code won't let a repo grant.
  describe.each(["config", "local"] as const)("permissions from %s.json", (file) => {
    it.each(["default", "acceptEdits", "dontAsk"] as const)("takes %s", (mode) => {
      expect(permissionsOf(parseProjectConfig({ [file]: json({ permissions: mode }) }))).toBe(mode);
    });

    it.each(["auto", "bypassPermissions"])("refuses %s, and says where it belongs", (mode) => {
      const read = parseProjectConfig({ [file]: json({ permissions: mode }) });
      expect(read.config).toBeNull();
      expect(read.problem).toBe(
        `.tenzo/${file}.json: permissions: "${mode}" is never taken from a file in the repo (Claude Code refuses it from project settings too). Set it as defaultMode in your own ~/.claude/settings.json: threads use that already.`,
      );
    });

    it.each(["plan", "yolo", 1])("refuses %j", (mode) => {
      const read = parseProjectConfig({ [file]: json({ permissions: mode }) });
      expect(read.config).toBeNull();
      expect(read.problem).toMatch(new RegExp(`^\\.tenzo/${file}\\.json: permissions: `));
    });
  });

  it("a local.json can't lift a refused mode over config.json, or the other way", () => {
    expect(parseProjectConfig({ config: json({ permissions: "auto" }), local: json({ permissions: "default" }) }).config).toBeNull();
    expect(parseProjectConfig({ config: json({ permissions: "default" }), local: json({ permissions: "auto" }) }).config).toBeNull();
  });
});

describe("project config: precedence", () => {
  const config = {
    models: {
      discuss: { model: "opus", thinking: "high" as const },
      build: { thinking: "medium" as const },
      agents: { model: "haiku" },
    },
  };
  const none = { model: null, thinking: null };

  it("thread over config over TENZO_DEFAULT_MODEL over the agent, field by field", () => {
    expect(resolveModels({ thread: none, config, defaultModel: "sonnet" })).toEqual({
      discuss: { model: "opus", thinking: "high" },
      build: { model: "sonnet", thinking: "medium" }, // no build model in the config: the default
      agents: "haiku",
    });
    expect(resolveModels({ thread: { model: "fable", thinking: null }, config, defaultModel: "sonnet" })).toEqual({
      discuss: { model: "fable", thinking: "high" },
      build: { model: "fable", thinking: "medium" },
      agents: "haiku",
    });
    expect(resolveModels({ thread: { model: null, thinking: "off" }, config })).toEqual({
      discuss: { model: "opus", thinking: "off" },
      build: { thinking: "off" },
      agents: "haiku",
    });
  });

  it("leaves everything to the agent with no config, no default and no override", () => {
    expect(resolveModels({ thread: none, config: {} })).toEqual({ discuss: {}, build: {} });
    expect(resolveModels({ thread: none, config: null })).toEqual({ discuss: {}, build: {} });
    expect(resolveModels({ thread: none, config: null, defaultModel: "haiku" })).toEqual({
      discuss: { model: "haiku" },
      build: { model: "haiku" },
    });
  });
});

describe("project config: reading the main checkout", () => {
  function repo(): string {
    const root = tempDir("repo");
    mkdirSync(join(root, ".tenzo"));
    return root;
  }

  it("reads both files, either optional", () => {
    const root = repo();
    expect(readProjectConfig(root)).toEqual(NO_CONFIG);
    writeFileSync(join(root, ".tenzo/config.json"), json({ landing: "pr" }));
    expect(readProjectConfig(root).config).toEqual({ landing: "pr" });
    writeFileSync(join(root, ".tenzo/local.json"), json({ landing: "merge" }));
    expect(readProjectConfig(root).config).toEqual({ landing: "merge" });
    rmSync(join(root, ".tenzo/config.json"));
    expect(readProjectConfig(root).config).toEqual({ landing: "merge" });
  });

  it("reads only a plain file: not a folder, nor a link anywhere, even one inside the repo", () => {
    const root = repo();
    mkdirSync(join(root, ".tenzo/config.json"));
    expect(readProjectConfig(root).problem).toBe(
      ".tenzo/config.json must be a plain file in the repo, not a link, folder or device; Tenzo didn't read it.",
    );
    rmSync(join(root, ".tenzo/config.json"), { recursive: true });
    const outside = join(tempDir("outside"), "secret.json");
    writeFileSync(outside, "root:x:0:0 not json");
    for (const target of ["/dev/zero", "/dev/urandom", outside, join(root, "README.md")]) {
      rmSync(join(root, ".tenzo/local.json"), { force: true });
      symlinkSync(target, join(root, ".tenzo/local.json"));
      const read = readProjectConfig(root);
      expect(read.problem).toBe(
        ".tenzo/local.json must be a plain file in the repo, not a link, folder or device; Tenzo didn't read it.",
      );
      expect(read.problem).not.toContain("root:x");
    }
  });

  it("doesn't follow a .tenzo folder that is a link", () => {
    const root = tempDir("repo");
    const elsewhere = tempDir("elsewhere");
    writeFileSync(join(elsewhere, "config.json"), json({ landing: "pr" }));
    symlinkSync(elsewhere, join(root, ".tenzo"));
    expect(readProjectConfig(root).problem).toBe(".tenzo must be a folder in the repo, not a link or a file; Tenzo didn't read it.");
  });

  it("refuses a file too large for a config without reading it", () => {
    const root = repo();
    writeFileSync(join(root, ".tenzo/config.json"), `{"landing":"pr"}${" ".repeat(MAX_CONFIG_BYTES)}`);
    expect(readProjectConfig(root).problem).toBe(
      ".tenzo/config.json is larger than 64 KB, too large for a config; Tenzo didn't read it.",
    );
    writeFileSync(join(root, ".tenzo/config.json"), `{"landing":"pr"}${" ".repeat(MAX_CONFIG_BYTES - 16)}`);
    expect(readProjectConfig(root).config).toEqual({ landing: "pr" });
  });

  it("treats a committed local.json as the repo's: it can't grant bypass either", () => {
    const root = initRepo("tracked");
    mkdirSync(join(root, ".tenzo"));
    writeFileSync(join(root, ".tenzo/local.json"), json({ permissions: "bypassPermissions" }));
    sh(root, "add", ".tenzo/local.json");
    sh(root, "commit", "-q", "-m", "local");
    expect(sh(root, "ls-files", ".tenzo/local.json")).toBe(".tenzo/local.json");
    expect(readProjectConfig(root).problem).toMatch(/never taken from a file in the repo/);
  });

  it("reads again only when a file changed", () => {
    const root = repo();
    const configs = new ProjectConfigs();
    const first = configs.read(root);
    expect(configs.read(root)).toBe(first);
    writeFileSync(join(root, ".tenzo/config.json"), json({ landing: "pr" }));
    const second = configs.read(root);
    expect(second.config).toEqual({ landing: "pr" });
    expect(configs.read(root)).toBe(second);
    writeFileSync(join(root, ".tenzo/config.json"), json({ landing: "merge", agent: "claude" }));
    expect(configs.read(root).config).toEqual({ landing: "merge", agent: "claude" });
  });
});
