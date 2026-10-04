import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { landedOn } from "./git.ts";
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
    try {
      const repo = initRepo("private");
      sh(repo, "remote", "add", "origin", remote.url);
      sh(repo, "config", "credential.helper", ""); // no stored password to find
      await expect(landedOn(repo, "main", 10_000)).rejects.toThrow(
        /Couldn't fetch main from origin: .*terminal prompts disabled/,
      );
    } finally {
      remote.close();
    }
  });
});
