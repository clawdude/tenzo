import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter } from "./agent/fake-agent.ts";
import { countLines, diffStat, listUntracked, parseRawNumstat } from "./diff.ts";
import { Engine } from "./engine.ts";
import { addProject } from "./projects.ts";
import { openStore, type Store } from "./store.ts";
import { commitFile, initRepo, removeTempDirs, sh, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

/** A repo on `main` and a worktree on `tenzo/work` cut from it. */
function setup() {
  const repo = initRepo("app");
  commitFile(repo, "app.ts", "one\ntwo\nthree\n");
  commitFile(repo, "old.ts", "a\nb\n");
  commitFile(repo, "gone.ts", "x\n");
  const worktree = join(tempDir("wt"), "work");
  sh(repo, "worktree", "add", "-q", "-b", "tenzo/work", worktree, "main");
  return { repo, worktree };
}

describe("diffStat", () => {
  it("counts what the worktree changed since it left main: committed, uncommitted, untracked", async () => {
    const { repo, worktree } = setup();
    commitFile(worktree, "app.ts", "one\nTWO\nthree\nfour\n", "edit app");
    sh(worktree, "mv", "old.ts", "renamed.ts");
    sh(worktree, "rm", "-q", "gone.ts");
    sh(worktree, "commit", "-qm", "move and remove");
    writeFileSync(join(worktree, "app.ts"), "one\nTWO\nthree\nfour\nfive\n"); // not committed
    mkdirSync(join(worktree, "lib"));
    writeFileSync(join(worktree, "lib/new.ts"), "export {};\nconst a = 1;"); // untracked
    writeFileSync(join(worktree, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
    // main moves on afterwards: its new commits aren't the thread's change.
    commitFile(repo, "later.ts", "later\n");

    const diff = await diffStat(worktree, "refs/heads/main", { baseName: "main" });
    expect(diff).toEqual({
      base: "main",
      files: [
        { path: "app.ts", status: "modified", added: 3, deleted: 1 },
        { path: "gone.ts", status: "deleted", added: 0, deleted: 1 },
        { path: "lib/new.ts", status: "untracked", added: 2, deleted: 0 },
        { path: "logo.png", status: "untracked", added: null, deleted: null },
        { path: "renamed.ts", from: "old.ts", status: "renamed", added: 0, deleted: 0 },
      ],
      fileCount: 5,
      added: 5,
      deleted: 2,
      truncated: false,
      merged: false,
    });
  });

  it("is empty for a worktree that changed nothing", async () => {
    const { worktree } = setup();
    expect(await diffStat(worktree, "main")).toEqual({
      base: "main",
      files: [],
      fileCount: 0,
      added: 0,
      deleted: 0,
      truncated: false,
      merged: false,
    });
  });

  it("compares a branch's commit when the worktree is gone, ignoring what isn't committed", async () => {
    const { repo, worktree } = setup();
    commitFile(worktree, "feature.ts", "a\nb\nc\n");
    writeFileSync(join(worktree, "scratch.ts"), "not committed\n");
    const diff = await diffStat(repo, "main", { head: "refs/heads/tenzo/work" });
    expect(diff.files).toEqual([{ path: "feature.ts", status: "added", added: 3, deleted: 0 }]);
  });

  it("lists at most maxFiles, with totals over all of them", async () => {
    const { worktree } = setup();
    for (let i = 0; i < 5; i++) writeFileSync(join(worktree, `f${i}.ts`), "x\n".repeat(i + 1));
    const diff = await diffStat(worktree, "main", { maxFiles: 3 });
    expect(diff.files.map((f) => f.path)).toEqual(["f0.ts", "f1.ts", "f2.ts"]);
    expect(diff).toMatchObject({ fileCount: 5, truncated: true });
    // The two left out weren't read (lines unknown), so the total is the listed ones'.
    expect(diff.added).toBe(1 + 2 + 3);
  });

  it("handles paths with spaces, tabs and unicode", async () => {
    const { worktree } = setup();
    commitFile(worktree, "a b\tc ü.ts", "1\n");
    const diff = await diffStat(worktree, "main");
    expect(diff.files).toEqual([{ path: "a b\tc ü.ts", status: "added", added: 1, deleted: 0 }]);
  });

  it("lists a file once when it left the index but is still on disk (git rm --cached)", async () => {
    const { worktree } = setup();
    sh(worktree, "rm", "-q", "--cached", "app.ts");
    const diff = await diffStat(worktree, "main");
    expect(diff.files).toEqual([{ path: "app.ts", status: "deleted", added: 0, deleted: 3 }]);
    expect(diff.fileCount).toBe(1);
  });

  it("stops listing untracked files at a cap, and says the diff is incomplete", async () => {
    const { worktree } = setup();
    mkdirSync(join(worktree, "node_modules"));
    for (let i = 0; i < 30; i++) writeFileSync(join(worktree, "node_modules", `m${i}.js`), "x\n");
    const diff = await diffStat(worktree, "main", { maxUntracked: 10 });
    expect(diff.files).toHaveLength(10);
    expect(diff).toMatchObject({ fileCount: 10, truncated: true });
    const listed = await listUntracked(worktree, 100);
    expect(listed).toMatchObject({ more: false });
    expect(listed.paths).toHaveLength(30);
  });

  it("says when an archived branch has landed in main already", async () => {
    const { repo, worktree } = setup();
    commitFile(worktree, "feature.ts", "a\n");
    sh(repo, "merge", "-q", "--ff-only", "tenzo/work");
    const diff = await diffStat(repo, "main", { head: "refs/heads/tenzo/work" });
    expect(diff).toMatchObject({ files: [], merged: true });
  });
});

describe("parseRawNumstat", () => {
  it("reads raw records for the status and numstat records for the counts, paths by position", () => {
    const raw =
      ":100644 100644 aaa bbb M\0app.ts\0" +
      ":000000 100644 000 ccc A\0logo.png\0" +
      ":100644 000000 ddd 000 D\0gone\tx.ts\0" +
      ":100644 100644 eee fff R087\0old.ts\0new.ts\0";
    const numstat = "3\t1\tapp.ts\0-\t-\tlogo.png\0" + "0\t2\tgone\tx.ts\0" + "1\t1\t\0old.ts\0new.ts\0";
    expect(parseRawNumstat(raw + numstat)).toEqual([
      { path: "app.ts", status: "modified", added: 3, deleted: 1 },
      { path: "logo.png", status: "added", added: null, deleted: null },
      { path: "gone\tx.ts", status: "deleted", added: 0, deleted: 2 },
      { path: "new.ts", from: "old.ts", status: "renamed", added: 1, deleted: 1 },
    ]);
  });
});

describe("countLines", () => {
  it("counts text lines, and nothing it shouldn't read", async () => {
    const dir = tempDir("count");
    const at = (name: string) => join(dir, name);
    writeFileSync(at("a"), "1\n2\n");
    writeFileSync(at("b"), "1\n2");
    writeFileSync(at("empty"), "");
    writeFileSync(at("bin"), Buffer.from([1, 0, 2]));
    writeFileSync(at("big"), Buffer.alloc(1024 * 1024 + 1, 97));
    symlinkSync(at("a"), at("link"));
    mkfifoSafe(at("fifo"));
    expect(await countLines(at("a"))).toEqual({ lines: 2, bytes: 4 });
    expect(await countLines(at("b"))).toEqual({ lines: 2, bytes: 3 });
    expect(await countLines(at("empty"))).toEqual({ lines: 0, bytes: 0 });
    for (const name of ["bin", "big", "link", "fifo", "missing"]) {
      expect(await countLines(at(name))).toBeNull();
    }
  });
});

/** A FIFO, where the platform makes them; a missing file otherwise reads the same (null). */
function mkfifoSafe(path: string): void {
  try {
    execFileSync("mkfifo", [path]);
  } catch {
    rmSync(path, { force: true });
  }
}

describe("thread.diff", () => {
  let home: string;
  let store: Store;
  let engine: Engine;
  beforeEach(async () => {
    home = join(tempDir("home"), ".tenzo");
    store = openStore(home);
    await addProject(store, initRepo("app"));
    engine = new Engine({ store, adapters: { claude: new FakeAdapter() } });
  });
  afterEach(async () => {
    await engine.close();
    store.close();
  });

  it("diffs an active thread's worktree, and an archived thread's branch", async () => {
    const thread = await engine.createThread({ project: "app", title: "Work" });
    commitFile(thread.worktreePath, "feature.ts", "a\nb\n");
    expect(await engine.diff(thread.id)).toMatchObject({
      base: "main",
      files: [{ path: "feature.ts", status: "added", added: 2, deleted: 0 }],
    });
    await engine.archive(thread.id);
    expect(await engine.diff(thread.id)).toMatchObject({
      files: [{ path: "feature.ts", status: "added", added: 2 }],
    });
    const project = engine.store.db.prepare("SELECT path FROM projects").get() as { path: string };
    sh(project.path, "branch", "-D", thread.branch);
    await expect(engine.diff(thread.id)).rejects.toThrow(/is gone \(deleted since the thread was archived\)/);
  });
});
