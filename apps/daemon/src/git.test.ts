import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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
