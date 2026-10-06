import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { freshBase, landedOn, runGit, stopDetachedGit } from "./git.ts";
import { commitFile, initRepo, removeTempDirs, sh, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

/**
 * A bare origin with `main`; `work`, a clone on a feature branch with a commit of its own
 * (what a thread's worktree holds); and `other`, a second clone where the merge happens, as
 * on GitHub.
 */
function setUp() {
  const origin = join(tempDir("origin"), "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch", "main", origin]);
  const seed = initRepo("seed");
  sh(seed, "push", "--quiet", origin, "main");
  const work = join(tempDir("work"), "work");
  sh(tempDir(), "clone", "--quiet", origin, work);
  sh(work, "checkout", "--quiet", "-b", "feature");
  commitFile(work, "CONTRIBUTING.md", "Be kind.\n");
  sh(work, "push", "--quiet", "origin", "feature");
  const other = join(tempDir("other"), "other");
  sh(tempDir(), "clone", "--quiet", origin, other);
  sh(other, "fetch", "--quiet", "origin", "feature");
  return { origin, work, other };
}

describe("landedOn", () => {
  it("is false until the branch's changes are in the default branch", async () => {
    const { work, other } = setUp();
    expect(await landedOn(work, "main")).toBe(false);
    // Something else lands meanwhile: still not this branch.
    commitFile(other, "OTHER.md", "Other work.\n");
    sh(other, "push", "--quiet", "origin", "main");
    expect(await landedOn(work, "main")).toBe(false);
  });

  it("is true after a merge commit", async () => {
    const { work, other } = setUp();
    sh(other, "merge", "--quiet", "--no-ff", "-m", "Merge feature", "origin/feature");
    sh(other, "push", "--quiet", "origin", "main");
    expect(await landedOn(work, "main")).toBe(true);
  });

  it("is true after a squash merge, even once the default branch has moved on", async () => {
    const { work, other } = setUp();
    sh(other, "merge", "--quiet", "--squash", "origin/feature");
    sh(other, "commit", "--quiet", "-m", "Add CONTRIBUTING.md (#1)");
    commitFile(other, "LATER.md", "Later work.\n");
    sh(other, "push", "--quiet", "origin", "main");
    expect(await landedOn(work, "main")).toBe(true);
  });

  it("is false when the default branch changed the same lines differently", async () => {
    const { work, other } = setUp();
    writeFileSync(join(other, "CONTRIBUTING.md"), "Be quick.\n");
    sh(other, "add", "CONTRIBUTING.md");
    sh(other, "commit", "--quiet", "-m", "Someone else's rules");
    sh(other, "push", "--quiet", "origin", "main");
    expect(await landedOn(work, "main")).toBe(false);
  });

  it("refuses to tell without an origin to fetch from", async () => {
    const repo = initRepo("alone");
    await expect(landedOn(repo, "main")).rejects.toThrow(/Couldn't fetch main from origin/);
  });
});

/** A local server that answers every request with `answer`, or never (it accepts and stalls). */
async function fakeRemote(
  answer?: (res: ServerResponse) => void,
): Promise<{ url: string; close: () => void }> {
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => answer?.(res));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

describe("landedOn's fetch, with nobody watching", () => {
  it("gives up on a remote that never answers, and says so", async () => {
    const remote = await fakeRemote();
    try {
      const repo = initRepo("stalled");
      sh(repo, "remote", "add", "origin", remote.url);
      const started = Date.now();
      await expect(landedOn(repo, "main", 1000)).rejects.toThrow(
        /Couldn't fetch main from origin: no answer in 1s\. Is origin reachable, and can git reach it without a password prompt\?/,
      );
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      remote.close();
    }
  });

  it("fails at once, never prompting, when origin wants a password", async () => {
    const remote = await fakeRemote((res) => {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="origin"' });
      res.end();
    });
    // Every askpass program the daemon could have inherited: none may be asked.
    const asked = join(tempDir("askpass"), "asked");
    const askpass = join(tempDir("askpass"), "askpass.sh");
    writeFileSync(askpass, `#!/bin/sh\necho "$@" >> '${asked}'\necho secret\n`, { mode: 0o755 });
    const saved = { GIT_ASKPASS: process.env.GIT_ASKPASS, SSH_ASKPASS: process.env.SSH_ASKPASS };
    process.env.GIT_ASKPASS = askpass;
    process.env.SSH_ASKPASS = askpass;
    try {
      const repo = initRepo("private");
      sh(repo, "remote", "add", "origin", remote.url);
      sh(repo, "config", "credential.helper", ""); // no stored password to find
      sh(repo, "config", "http.proxy", ""); // straight to 127.0.0.1, whatever the environment says
      sh(repo, "config", "core.askPass", askpass);
      await expect(landedOn(repo, "main", 10_000)).rejects.toThrow(
        /Couldn't fetch main from origin: .*terminal prompts disabled/,
      );
      expect(existsSync(asked)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      remote.close();
    }
  });

  it("stops when the daemon does, helpers and all", async () => {
    const remote = await fakeRemote();
    try {
      const repo = initRepo("stopping");
      sh(repo, "remote", "add", "origin", remote.url);
      const checking = landedOn(repo, "main", 60_000);
      await new Promise((done) => setTimeout(done, 300));
      const started = Date.now();
      stopDetachedGit();
      await expect(checking).rejects.toThrow(/git fetch was stopped: Tenzo is stopping/);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      remote.close();
    }
  });
});

/**
 * A bare origin with `main`; `mine`, your clone of it (where threads are cut); and `other`, a
 * second clone that lands work on origin, as a merged PR does.
 */
function setUpClones() {
  const origin = join(tempDir("origin"), "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch", "main", origin]);
  sh(initRepo("seed"), "push", "--quiet", origin, "main");
  const mine = join(tempDir("mine"), "mine");
  sh(tempDir(), "clone", "--quiet", origin, mine);
  const other = join(tempDir("other"), "other");
  sh(tempDir(), "clone", "--quiet", origin, other);
  return { mine, other };
}

describe("freshBase", () => {
  it("starts from origin's default branch when yours is behind it, and leaves yours alone", async () => {
    const { mine, other } = setUpClones();
    const yours = sh(mine, "rev-parse", "main");
    const landed = commitFile(other, "MERGED.md", "Merged work.\n");
    sh(other, "push", "--quiet", "origin", "main");

    const base = await freshBase(mine, "main");

    expect(base).toEqual({ ref: "refs/remotes/origin/main", note: null });
    expect(sh(mine, "rev-parse", base.ref)).toBe(landed);
    expect(sh(mine, "rev-parse", "main")).toBe(yours);
    expect(sh(mine, "status", "--porcelain")).toBe("");
  });

  it("starts from yours when it is ahead of origin's", async () => {
    const { mine } = setUpClones();
    commitFile(mine, "LOCAL.md", "Not pushed yet.\n");
    expect(await freshBase(mine, "main")).toEqual({ ref: "refs/heads/main", note: null });
  });

  it("starts from yours when they have diverged, and says so", async () => {
    const { mine, other } = setUpClones();
    const yours = commitFile(mine, "LOCAL.md", "Not pushed yet.\n");
    commitFile(other, "A.md", "a\n");
    commitFile(other, "B.md", "b\n");
    sh(other, "push", "--quiet", "origin", "main");

    const base = await freshBase(mine, "main");

    expect(base.ref).toBe("refs/heads/main");
    expect(base.note).toMatch(
      /^Started from your local main, which has diverged from origin\/main \(1 commit only in main, 2 only in origin\/main\)\./,
    );
    expect(sh(mine, "rev-parse", "main")).toBe(yours);
  });

  it("starts from yours without an origin, fetching nothing", async () => {
    const repo = initRepo("alone");
    expect(await freshBase(repo, "main")).toEqual({ ref: "refs/heads/main", note: null });
  });

  it("starts from origin's when there is no local branch", async () => {
    const { mine } = setUpClones();
    sh(mine, "switch", "--quiet", "--detach");
    sh(mine, "branch", "--quiet", "-D", "main");
    expect(await freshBase(mine, "main")).toEqual({ ref: "refs/remotes/origin/main", note: null });
  });

  it("starts from what is here when origin can't be reached", async () => {
    const { mine } = setUpClones();
    sh(mine, "remote", "set-url", "origin", join(tempDir("gone"), "nowhere.git"));
    expect(await freshBase(mine, "main")).toEqual({ ref: "refs/heads/main", note: null });
  });

  it("gives up quickly on an origin that never answers", async () => {
    const remote = await fakeRemote();
    try {
      const repo = initRepo("stalled");
      sh(repo, "remote", "add", "origin", remote.url);
      const started = Date.now();
      expect(await freshBase(repo, "main", 500)).toEqual({ ref: "refs/heads/main", note: null });
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      remote.close();
    }
  });
});

describe("runGit", () => {
  it("keeps characters whole that fall across two chunks of output", async () => {
    const repo = initRepo("utf8");
    const text = "é€😀".repeat(200_000); // 2, 3 and 4 bytes: some must straddle a chunk
    writeFileSync(join(repo, "f.txt"), text);
    sh(repo, "add", "f.txt");
    const result = await runGit(repo, ["cat-file", "-p", ":f.txt"]);
    expect(result.stdout).toHaveLength(text.length);
    expect(result.stdout).toBe(text);
  });
});
