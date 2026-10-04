import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readConfig } from "./config.ts";
import {
  installWarnings,
  isLinkedWorktree,
  type LaunchAgent,
  launchAgentFor,
  launchAgentPlist,
  plistPath,
  SERVICE_LABEL,
  serviceEnv,
} from "./service.ts";
import { removeTempDirs, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

const agent: LaunchAgent = {
  node: "/opt/homebrew/bin/node",
  cli: "/Users/me/code/tenzo/apps/daemon/src/cli.ts",
  cwd: "/Users/me/code/tenzo",
  env: {
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    TENZO_HOME: "/Users/me/.tenzo",
    TENZO_ALLOWED_HOSTS: "my-mac.tailnet-1234.ts.net",
    ODD: `a & b < c > d "e" 'f'`,
  },
  log: "/Users/me/.tenzo/daemon.log",
};

describe("launchAgentPlist", () => {
  const plist = launchAgentPlist(agent);

  it("runs `node cli.ts serve` from the checkout, at login, again after a crash, logging to the home", () => {
    expect(plist).toContain(`<key>Label</key>\n    <string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain(
      [
        "<key>ProgramArguments</key>",
        "    <array>",
        "      <string>/opt/homebrew/bin/node</string>",
        "      <string>/Users/me/code/tenzo/apps/daemon/src/cli.ts</string>",
        "      <string>serve</string>",
        "    </array>",
      ].join("\n"),
    );
    expect(plist).toContain("<key>WorkingDirectory</key>\n    <string>/Users/me/code/tenzo</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain("<key>StandardOutPath</key>\n    <string>/Users/me/.tenzo/daemon.log</string>");
    expect(plist).toContain("<key>StandardErrorPath</key>\n    <string>/Users/me/.tenzo/daemon.log</string>");
  });

  it("passes the environment, escaped for XML", () => {
    expect(plist).toContain(
      "<key>TENZO_ALLOWED_HOSTS</key>\n      <string>my-mac.tailnet-1234.ts.net</string>",
    );
    expect(plist).toContain("<key>PATH</key>\n      <string>/opt/homebrew/bin:/usr/bin:/bin</string>");
    expect(plist).toContain(
      "<key>ODD</key>\n      <string>a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;</string>",
    );
  });

  it.runIf(process.platform === "darwin")("is a property list macOS accepts", () => {
    const file = join(tempDir("plist"), `${SERVICE_LABEL}.plist`);
    writeFileSync(file, plist);
    const lint = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
    expect(lint.stdout + lint.stderr).toContain("OK");
    const json = spawnSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
    const parsed = JSON.parse(json.stdout);
    expect(parsed.EnvironmentVariables).toEqual(agent.env);
    expect(parsed.ProgramArguments).toEqual([agent.node, agent.cli, "serve"]);
    expect(parsed.KeepAlive).toEqual({ SuccessfulExit: false });
  });
});

describe("serviceEnv", () => {
  it("keeps the user's setup and drops the terminal session, pnpm's and a parent Claude Code's", () => {
    const env = serviceEnv({
      PATH: "/repo/node_modules/.bin:/repo/apps/daemon/node_modules/.bin:/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/me",
      LANG: "en_US.UTF-8",
      TENZO_PORT: "4790",
      TENZO_ALLOWED_HOSTS: "my-mac.ts.net",
      CLAUDE_CONFIG_DIR: "/Users/me/.claude-work",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      HTTPS_PROXY: "http://proxy:3128",
      GITHUB_TOKEN: "ghp_x", // an MCP server in the user's config may read it
      PWD: "/repo",
      OLDPWD: "/",
      SHLVL: "2",
      _: "/usr/bin/env",
      TERM: "xterm-256color",
      TERM_PROGRAM: "iTerm.app",
      TMUX: "/tmp/tmux-501/default,1,0",
      TMUX_PANE: "%1",
      SSH_AUTH_SOCK: "/tmp/ssh",
      TMPDIR: "/var/folders/x/T/",
      XPC_SERVICE_NAME: "0",
      npm_lifecycle_event: "tenzo",
      npm_config_user_agent: "pnpm/10",
      PNPM_SCRIPT_SRC_DIR: "/repo",
      CLAUDECODE: "1",
      CLAUDE_CODE_SSE_PORT: "1234",
      AI_AGENT: "claude-code",
      GIT_EDITOR: "true",
      NoDefaultCurrentDirectoryInExePath: "1",
      COREPACK_ENABLE_AUTO_PIN: "0",
      OSLogRateLimit: "64",
      BAD: "a\u0001b",
      "NOT-A-NAME": "x",
      UNSET: undefined,
    });
    expect(env).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/me",
      LANG: "en_US.UTF-8",
      TENZO_PORT: "4790",
      TENZO_ALLOWED_HOSTS: "my-mac.ts.net",
      CLAUDE_CONFIG_DIR: "/Users/me/.claude-work",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      HTTPS_PROXY: "http://proxy:3128",
      GITHUB_TOKEN: "ghp_x",
    });
  });
});

describe("launchAgentFor", () => {
  it("runs this checkout with this Node, with the state, web and claude paths made absolute", () => {
    const home = tempDir("home");
    const env = { PATH: "/usr/bin", TENZO_HOME: home, TENZO_CLAUDE_PATH: "bin/claude" };
    const made = launchAgentFor(readConfig(env), env);
    const root = resolve(import.meta.dirname, "../../..");
    expect(made).toMatchObject({
      node: process.execPath,
      cli: join(root, "apps/daemon/src/cli.ts"),
      cwd: root,
      log: join(home, "daemon.log"),
    });
    expect(made.env).toEqual({
      PATH: "/usr/bin",
      TENZO_HOME: home,
      TENZO_WEB_DIR: join(root, "apps/web/build"),
      TENZO_CLAUDE_PATH: resolve("bin/claude"),
    });
  });

  it("puts the plist with the user's launch agents", () => {
    expect(plistPath("/Users/me")).toBe(`/Users/me/Library/LaunchAgents/${SERVICE_LABEL}.plist`);
  });
});

describe("installWarnings", () => {
  it("warns about a linked worktree checkout and an install from inside Claude Code", () => {
    expect(installWarnings({}, false)).toEqual([]);
    const both = installWarnings({ CLAUDECODE: "1" }, true);
    expect(both).toHaveLength(2);
    expect(both[0]).toMatch(/linked git worktree.*main checkout/);
    expect(both[1]).toMatch(/inside Claude Code \(CLAUDECODE is set\)/);
  });

  it("tells a linked worktree (.git is a file) from a main checkout (.git is a folder)", () => {
    const main = tempDir("main");
    mkdirSync(join(main, ".git"));
    const linked = tempDir("linked");
    writeFileSync(join(linked, ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n");
    expect(isLinkedWorktree(main)).toBe(false);
    expect(isLinkedWorktree(linked)).toBe(true);
    expect(isLinkedWorktree(tempDir("none"))).toBe(false);
  });
});
