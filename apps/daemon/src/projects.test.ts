import { existsSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ProjectId } from "@tenzo/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addProject, findProject, listProjects, removeProject } from "./projects.ts";
import { openStore, type Store } from "./store.ts";
import { initRepo, removeTempDirs, sh, tempDir } from "./testing.ts";
import { archiveThread, createThread, getThread, listThreads } from "./threads.ts";

let home: string;
const open: Store[] = [];
const store = () => {
  const s = openStore(home);
  open.push(s);
  return s;
};

beforeEach(() => {
  for (const s of open.splice(0)) s.close();
  home = join(tempDir("home"), ".tenzo");
});
afterAll(() => {
  for (const s of open.splice(0)) s.close();
  removeTempDirs();
});

describe("projects", () => {
  it("add, list and remove persist across reopening the store", async () => {
    const repo = initRepo("app");
    const added = await addProject(store(), repo);
    expect(ProjectId.safeParse(added.id).success).toBe(true);
    expect(added).toMatchObject({ name: "app", path: repo, defaultBranch: "main" });

    expect(listProjects(store())).toEqual([added]);
    expect(removeProject(store(), "app")).toEqual(added);
    expect(listProjects(store())).toEqual([]);
  });

  it("keeps its state private under TENZO_HOME", () => {
    store();
    expect(existsSync(join(home, "tenzo.db"))).toBe(true);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("registers the repo's top level when given a subdirectory or a symlink", async () => {
    const repo = initRepo("app");
    mkdirSync(join(repo, "src"));
    const link = join(tempDir("links"), "app-link");
    symlinkSync(repo, link);
    expect((await addProject(store(), join(repo, "src"))).path).toBe(repo);
    await expect(addProject(store(), link)).rejects.toThrow(/already a project, "app"/);
  });

  it("rejects paths that are not git repos", async () => {
    const plain = tempDir("plain");
    await expect(addProject(store(), plain)).rejects.toThrow(/not inside a git working tree/);
    await expect(addProject(store(), join(plain, "missing"))).rejects.toThrow(/not a directory/);
    expect(listProjects(store())).toEqual([]);
  });

  it("gives same-named repos distinct names", async () => {
    const a = await addProject(store(), initRepo("my app"));
    const b = await addProject(store(), initRepo("my app"));
    expect([a.name, b.name]).toEqual(["my-app", "my-app-2"]);
  });

  it("finds a project by name, id or path", async () => {
    const repo = initRepo("app");
    mkdirSync(join(repo, "src"));
    const p = await addProject(store(), repo);
    expect(findProject(store(), "app")).toEqual(p);
    expect(findProject(store(), p.id)).toEqual(p);
    expect(findProject(store(), join(repo, "src"))).toEqual(p);
    expect(() => findProject(store(), "nope")).toThrow(/No project "nope"/);
  });

  it("writes nothing into the repo", async () => {
    const repo = initRepo("app");
    const before = sh(repo, "rev-parse", "HEAD");
    const project = await addProject(store(), repo);
    const thread = await createThread(store(), project.name, "anything");
    await archiveThread(store(), thread.id);
    removeProject(store(), project.name);
    expect(sh(repo, "status", "--porcelain", "--ignored")).toBe("");
    expect(existsSync(join(repo, ".tenzo"))).toBe(false);
    expect(sh(repo, "rev-parse", "HEAD")).toBe(before);
  });

  it("refuses to remove a project with active threads", async () => {
    const project = await addProject(store(), initRepo("app"));
    const thread = await createThread(store(), "app", "work");
    expect(() => removeProject(store(), "app")).toThrow(/1 active thread.*Archive them first/);
    await archiveThread(store(), thread.id);
    expect(removeProject(store(), "app").id).toBe(project.id);
  });

  it("removing keeps the history: threads stay, and adding the repo again brings it back", async () => {
    const repo = initRepo("app");
    const project = await addProject(store(), repo);
    const thread = await createThread(store(), "app", "work");
    await archiveThread(store(), thread.id);
    removeProject(store(), "app");
    expect(listProjects(store())).toEqual([]);
    expect(() => findProject(store(), "app")).toThrow(/No project "app"/);
    expect(getThread(store(), thread.id).status).toBe("archived");

    const again = await addProject(store(), repo);
    expect(again).toEqual(project);
    expect(listThreads(store(), { includeArchived: true }).map((t) => t.id)).toEqual([thread.id]);
    await expect(addProject(store(), repo)).rejects.toThrow(/already a project/);
  });

  it("stamps this machine's environment id on projects and threads", async () => {
    const s = store();
    const project = await addProject(s, initRepo("app"));
    const thread = await createThread(s, "app", "work");
    expect(project.environmentId).toBe(s.environmentId);
    expect(thread.environmentId).toBe(s.environmentId);
    // Rows written before records carried it get it on the next open.
    s.db.exec("UPDATE projects SET environment_id = NULL; UPDATE threads SET environment_id = NULL");
    const reopened = store();
    expect(listProjects(reopened)[0]?.environmentId).toBe(s.environmentId);
    expect(getThread(reopened, thread.id).environmentId).toBe(s.environmentId);
  });
});

describe("default branch detection", () => {
  it("prefers what origin/HEAD points at", async () => {
    const upstream = initRepo("upstream", "trunk");
    const clone = join(tempDir("clones"), "clone");
    sh(upstream, "clone", "--quiet", upstream, clone);
    sh(clone, "switch", "--quiet", "-c", "feature");
    expect((await addProject(store(), clone)).defaultBranch).toBe("trunk");
  });

  it("falls back to main or master, then the checked-out branch", async () => {
    const master = initRepo("old", "master");
    sh(master, "switch", "--quiet", "-c", "feature");
    expect((await addProject(store(), master)).defaultBranch).toBe("master");
    expect((await addProject(store(), initRepo("dev-only", "develop"))).defaultBranch).toBe(
      "develop",
    );
  });
});
