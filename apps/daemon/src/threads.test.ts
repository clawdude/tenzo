import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { ThreadId } from "@tenzo/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { diffStat } from "./diff.ts";
import { addWorktree, commitsAhead, forkPoint } from "./git.ts";
import { addProject, type Project, removeProject } from "./projects.ts";
import { slugify } from "./slug.ts";
import { openStore, type Store } from "./store.ts";
import { commitFile, initRepo, removeTempDirs, sh, tempDir } from "./testing.ts";
import {
  archiveThread,
  createThread,
  getThread,
  listThreads,
  setThreadSession,
} from "./threads.ts";

let home: string;
let repo: string;
let project: Project;
let store: Store;

beforeEach(async () => {
  store?.close();
  home = join(tempDir("home"), ".tenzo");
  repo = initRepo("app");
  store = openStore(home);
  project = await addProject(store, repo);
});
afterAll(() => {
  store.close();
  removeTempDirs();
});

const branches = (dir: string) => sh(dir, "branch", "--format=%(refname:short)").split("\n").sort();
const worktrees = (dir: string) =>
  sh(dir, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

describe("createThread", () => {
  it("creates a worktree on tenzo/<slug> from the default branch, under TENZO_HOME", async () => {
    const thread = await createThread(store, "app", "Fix the login bug");
    expect(ThreadId.safeParse(thread.id).success).toBe(true);
    expect(thread).toMatchObject({
      title: "Fix the login bug",
      slug: "fix-the-login-bug",
      branch: "tenzo/fix-the-login-bug",
      status: "active",
    });
    expect(thread.worktreePath).toBe(join(home, "worktrees", "app", thread.id));

    expect(existsSync(join(thread.worktreePath, "README.md"))).toBe(true);
    expect(sh(thread.worktreePath, "branch", "--show-current")).toBe("tenzo/fix-the-login-bug");
    expect(sh(thread.worktreePath, "rev-parse", "HEAD")).toBe(sh(repo, "rev-parse", "main"));
    expect(worktrees(repo)).toContain(thread.worktreePath);
    const reopened = openStore(home);
    expect(listThreads(reopened)).toEqual([thread]);
    reopened.close();
  });

  it("leaves the main checkout alone, even when it's on another branch with local edits", async () => {
    const mainTip = sh(repo, "rev-parse", "main");
    sh(repo, "switch", "--quiet", "-c", "wip");
    commitFile(repo, "wip.txt", "wip\n");
    writeFileSync(join(repo, "README.md"), "# edited, not committed\n");
    const status = sh(repo, "status", "--porcelain");

    const thread = await createThread(store, "app", "something");

    expect(sh(thread.worktreePath, "rev-parse", "HEAD")).toBe(mainTip); // from main, not from wip
    expect(existsSync(join(thread.worktreePath, "wip.txt"))).toBe(false);
    expect(sh(repo, "branch", "--show-current")).toBe("wip");
    expect(sh(repo, "status", "--porcelain")).toBe(status);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# edited, not committed\n");
  });

  it("puts worktrees under TENZO_HOME even when it was given as a relative path", async () => {
    store.close();
    store = openStore(relative(process.cwd(), home)); // git runs in the repo: must not resolve there
    const thread = await createThread(store, "app", "relative");
    expect(thread.worktreePath).toBe(join(home, "worktrees", "app", thread.id));
    expect(existsSync(thread.worktreePath)).toBe(true);
    expect(sh(repo, "status", "--porcelain", "--ignored")).toBe("");
  });

  it("refuses a relative worktree path outright", async () => {
    await expect(addWorktree(repo, "relhome/wt", "tenzo/x", "refs/heads/main")).rejects.toThrow(
      /must be absolute/,
    );
    expect(sh(repo, "status", "--porcelain", "--ignored")).toBe("");
    expect(branches(repo)).toEqual(["main"]);
  });

  it("does not make the thread branch track the default branch's upstream", async () => {
    const thread = await createThread(store, "app", "x");
    expect(() => sh(repo, "config", "--get", `branch.${thread.branch}.merge`)).toThrow();
  });

  it("numbers colliding slugs: same title, an existing branch, an archived thread", async () => {
    const first = await createThread(store, "app", "Add search");
    const second = await createThread(store, "app", "add search!");
    expect([first.slug, second.slug]).toEqual(["add-search", "add-search-2"]);

    sh(repo, "branch", "tenzo/dark-mode"); // the user's own branch, or one left by a removed project
    expect((await createThread(store, "app", "Dark mode")).slug).toBe("dark-mode-2");

    await archiveThread(store, first.id); // its branch is kept, so its name stays taken
    expect((await createThread(store, "app", "Add search")).slug).toBe("add-search-3");
  });

  it("starts from what landed on origin when your default branch is behind, which it leaves alone", async () => {
    const origin = join(tempDir("origin"), "origin.git");
    sh(tempDir(), "init", "--quiet", "--bare", "--initial-branch", "main", origin);
    sh(repo, "remote", "add", "origin", origin);
    sh(repo, "push", "--quiet", "origin", "main");
    const yours = sh(repo, "rev-parse", "main");
    const other = join(tempDir("other"), "other");
    sh(tempDir(), "clone", "--quiet", origin, other);
    const landed = commitFile(other, "MERGED.md", "Merged work.\n");
    sh(other, "push", "--quiet", "origin", "main");
    const notes: string[] = [];

    const thread = await createThread(store, "app", "next", { onBaseNote: (n) => notes.push(n) });

    expect(sh(thread.worktreePath, "rev-parse", "HEAD")).toBe(landed);
    expect(sh(repo, "rev-parse", "main")).toBe(yours);
    expect(notes).toEqual([]);

    // Yours and origin's diverge: yours, and a note saying so.
    commitFile(thread.worktreePath, "THREAD.md", "The thread's work.\n");
    const local = commitFile(repo, "LOCAL.md", "Local work.\n");
    const diverged = await createThread(store, "app", "again", { onBaseNote: (n) => notes.push(n) });
    expect(sh(diverged.worktreePath, "rev-parse", "HEAD")).toBe(local);
    expect(notes).toEqual([expect.stringMatching(/^Started from your local main, which has diverged/)]);

    // The first thread's own work is still just its own, measured from its nearest fork point
    // (origin's), not from your main, which now looks older to it: in its worktree and by branch.
    const own = async (cwd: string, head?: string) => {
      const base = await forkPoint(cwd, "main", head);
      const diff = await diffStat(cwd, base, head ? { head } : {});
      return { files: diff.files.map((f) => f.path), ahead: await commitsAhead(cwd, base, head ?? "HEAD") };
    };
    expect(await own(thread.worktreePath)).toEqual({ files: ["THREAD.md"], ahead: 1 });
    expect(await own(repo, `refs/heads/${thread.branch}`)).toEqual({ files: ["THREAD.md"], ahead: 1 });
  });

  it("refuses an unknown project or a repo with no commits", async () => {
    await expect(createThread(store, "nope", "x")).rejects.toThrow(/No project "nope"/);
    const empty = join(tempDir("empty"), "empty");
    sh(tempDir(), "init", "--quiet", "--initial-branch", "main", empty);
    await addProject(store, empty);
    await expect(createThread(store, "empty", "x")).rejects.toThrow(/has no commits/);
  });
});

describe("archiveThread", () => {
  it("removes the worktree and keeps the branch with its commits", async () => {
    const thread = await createThread(store, "app", "Build it");
    const tip = commitFile(thread.worktreePath, "feature.txt", "done\n");

    const archived = await archiveThread(store, thread.id);

    expect(archived).toMatchObject({ status: "archived", archivedAt: expect.any(String) });
    expect(existsSync(thread.worktreePath)).toBe(false);
    expect(worktrees(repo)).not.toContain(thread.worktreePath);
    expect(branches(repo)).toEqual(["main", "tenzo/build-it"]);
    expect(sh(repo, "rev-parse", "tenzo/build-it")).toBe(tip);
    expect(sh(repo, "status", "--porcelain")).toBe("");

    const reopened = openStore(home);
    expect(getThread(reopened, thread.id).status).toBe("archived");
    expect(listThreads(reopened)).toEqual([]);
    expect(listThreads(reopened, { includeArchived: true })).toHaveLength(1);
    reopened.close();
  });

  it("refuses to throw away uncommitted work unless forced", async () => {
    const thread = await createThread(store, "app", "Risky");
    writeFileSync(join(thread.worktreePath, "unsaved.txt"), "precious\n");

    await expect(archiveThread(store, thread.id)).rejects.toThrow(/uncommitted changes/);
    expect(existsSync(join(thread.worktreePath, "unsaved.txt"))).toBe(true);
    expect(getThread(store, thread.id).status).toBe("active");

    await archiveThread(store, thread.id, { force: true });
    expect(existsSync(thread.worktreePath)).toBe(false);
    expect(branches(repo)).toContain("tenzo/risky");
  });

  it("copes with a worktree someone already deleted by hand", async () => {
    const thread = await createThread(store, "app", "Gone");
    rmSync(thread.worktreePath, { recursive: true, force: true });
    await archiveThread(store, thread.id);
    expect(worktrees(repo)).toEqual([repo]); // the stale registration was pruned
    expect(getThread(store, thread.id).status).toBe("archived");
  });

  it("lets go of a thread whose repo was moved or deleted, with --force", async () => {
    const thread = await createThread(store, "app", "Orphan");
    renameSync(repo, `${repo}-moved`);

    await expect(archiveThread(store, thread.id)).rejects.toThrow(/is gone.*--force/);
    expect(getThread(store, thread.id).status).toBe("active");
    expect(() => removeProject(store, "app")).toThrow(/active thread/);

    await archiveThread(store, thread.id, { force: true });
    expect(existsSync(thread.worktreePath)).toBe(false);
    expect(getThread(store, thread.id).status).toBe("archived");
    expect(removeProject(store, "app").id).toBe(project.id); // no longer a dead end
  });

  it("never deletes a folder outside TENZO_HOME/worktrees, even for a gone repo", async () => {
    const thread = await createThread(store, "app", "Tampered");
    const outside = tempDir("precious");
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    store.db.prepare("UPDATE threads SET worktree_path = ? WHERE id = ?").run(outside, thread.id);
    rmSync(repo, { recursive: true, force: true });

    await expect(archiveThread(store, thread.id, { force: true })).rejects.toThrow(/Refusing/);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  it("only deletes the exact folder Tenzo made for that thread", async () => {
    const thread = await createThread(store, "app", "Neighbour");
    const sibling = await createThread(store, "app", "Sibling");
    rmSync(repo, { recursive: true, force: true });

    for (const tampered of [
      sibling.worktreePath,
      join(home, "worktrees"),
      join(home, "worktrees", "app"),
    ]) {
      store.db
        .prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
        .run(tampered, thread.id);
      await expect(archiveThread(store, thread.id, { force: true })).rejects.toThrow(
        /^Refusing to delete .*: Tenzo made this thread's worktree at /,
      );
    }
    expect(existsSync(join(sibling.worktreePath, "README.md"))).toBe(true);
    expect(getThread(store, thread.id).status).toBe("active");
  });

  it("refuses to follow a symlinked project folder or worktree out of TENZO_HOME", async () => {
    const thread = await createThread(store, "app", "Linked");
    rmSync(repo, { recursive: true, force: true });
    const outside = tempDir("precious");
    mkdirSync(join(outside, thread.id));
    writeFileSync(join(outside, thread.id, "keep.txt"), "keep\n");

    // The project's folder under worktrees/ now points somewhere else.
    const projectDir = join(home, "worktrees", "app");
    rmSync(projectDir, { recursive: true, force: true });
    symlinkSync(outside, projectDir);
    await expect(archiveThread(store, thread.id, { force: true })).rejects.toThrow(
      /^Refusing to delete .*: its folder does not resolve to /,
    );
    expect(existsSync(join(outside, thread.id, "keep.txt"))).toBe(true);

    // The worktree itself is a symlink to somewhere else.
    rmSync(projectDir);
    mkdirSync(projectDir);
    symlinkSync(join(outside, thread.id), thread.worktreePath);
    await expect(archiveThread(store, thread.id, { force: true })).rejects.toThrow(
      /not a plain folder/,
    );
    expect(existsSync(join(outside, thread.id, "keep.txt"))).toBe(true);
    expect(getThread(store, thread.id).status).toBe("active");
  });

  it("is idempotent and filters by project", async () => {
    const thread = await createThread(store, "app", "Twice");
    const once = await archiveThread(store, thread.id);
    expect(await archiveThread(store, thread.id)).toEqual(once);
    const other = await addProject(store, initRepo("other"));
    await createThread(store, "other", "y");
    expect(
      listThreads(store, { projectId: project.id, includeArchived: true }).map((t) => t.id),
    ).toEqual([thread.id]);
    expect(listThreads(store, { projectId: other.id })).toHaveLength(1);
  });
});

describe("setThreadSession", () => {
  it("remembers the agent session so a later run can resume it", async () => {
    const thread = await createThread(store, "app", "Resume me");
    expect(thread).toMatchObject({ agent: null, sessionId: null });
    const session = "5b0c7a6e-3f1d-4c2b-9a8e-1d2c3b4a5f60";
    setThreadSession(store, thread.id, "claude", session);
    const reopened = openStore(home); // as after a restart
    expect(getThread(reopened, thread.id)).toMatchObject({ agent: "claude", sessionId: session });
    expect(listThreads(reopened)[0]?.sessionId).toBe(session);
    reopened.close();
  });
});

describe("slugify", () => {
  it("makes short, git-safe slugs", () => {
    expect(slugify("Fix the login bug!", "thread")).toBe("fix-the-login-bug");
    expect(slugify("  Crème brûlée -- API v2  ", "thread")).toBe("creme-brulee-api-v2");
    expect(slugify("../../etc/passwd", "thread")).toBe("etc-passwd");
    expect(slugify("🍜", "thread")).toBe("thread");
    expect(slugify("refactor the payment provider integration layer completely", "t")).toBe(
      "refactor-the-payment-provider",
    );
    expect(slugify("a".repeat(60), "t")).toHaveLength(40);
  });
});
