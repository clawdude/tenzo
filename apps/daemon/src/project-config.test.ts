import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  landingOf,
  mergeConfig,
  NO_CONFIG,
  parseProjectConfig,
  permissionsOf,
  ProjectConfigs,
  readProjectConfig,
  resolveModels,
} from "./project-config.ts";
import { removeTempDirs, tempDir } from "./testing.ts";

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
    [{ config: json({ models: { discuss: { model: "" } } }) }, /models\.discuss\.model: must name a model/],
    [{ config: json({ permissions: "plan" }) }, /permissions: /],
    [{ config: json({ landing: "squash" }) }, /landing: /],
    [{ config: json([]) }, /^\.tenzo\/config\.json: /],
    [{ local: json({ landing: 1 }) }, /^\.tenzo\/local\.json: landing: /],
  ])("says clearly what is wrong with %j", (files, problem) => {
    const read = parseProjectConfig(files);
    expect(read.config).toBeNull();
    expect(read.problem).toMatch(problem);
  });

  it("takes bypassPermissions only from your own local.json, never from the committed config", () => {
    const committed = parseProjectConfig({ config: json({ permissions: "bypassPermissions" }) });
    expect(committed.config).toBeNull();
    expect(committed.problem).toMatch(/only taken from \.tenzo\/local\.json/);
    const local = parseProjectConfig({ local: json({ permissions: "bypassPermissions" }) });
    expect(permissionsOf(local)).toBe("bypassPermissions");
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

  it("says when a file can't be read", () => {
    const root = repo();
    mkdirSync(join(root, ".tenzo/config.json"));
    expect(readProjectConfig(root).problem).toMatch(/^Can't read \.tenzo\/config\.json/);
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
