import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS, type Migration, openDatabase, schemaVersion } from "./db.ts";
import { removeTempDirs, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

const tables = (db: ReturnType<typeof openDatabase>) =>
  db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);

describe("openDatabase", () => {
  it("creates the schema on first open", () => {
    const db = openDatabase(join(tempDir(), "tenzo.db"));
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(tables(db)).toEqual([
      "events",
      "items",
      "projects",
      "prompts",
      "sqlite_sequence",
      "threads",
    ]);
    expect(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    db.close();
  });

  it("runs only the migrations a database hasn't seen, and keeps the data", () => {
    const path = join(tempDir(), "tenzo.db");
    const v1: Migration[] = [{ name: "a", sql: "CREATE TABLE a (x TEXT) STRICT" }];
    const first = openDatabase(path, v1);
    first.prepare("INSERT INTO a VALUES ('kept')").run();
    first.close();

    const v2 = [...v1, { name: "b", sql: "ALTER TABLE a ADD COLUMN y TEXT" }];
    const second = openDatabase(path, v2); // re-running "a" would fail: the table exists
    expect(schemaVersion(second)).toBe(2);
    expect(second.prepare("SELECT x, y FROM a").all()).toEqual([{ x: "kept", y: null }]);
    second.close();

    const third = openDatabase(path, v2);
    expect(schemaVersion(third)).toBe(2);
    third.close();
  });

  it("rolls back every step of a failed upgrade", () => {
    const path = join(tempDir(), "tenzo.db");
    openDatabase(path, []).close();
    const broken: Migration[] = [
      { name: "good", sql: "CREATE TABLE good (x TEXT)" },
      { name: "bad", sql: "CREATE TABLE nope (" },
    ];
    expect(() => openDatabase(path, broken)).toThrow();
    const db = openDatabase(path, []);
    expect(schemaVersion(db)).toBe(0);
    expect(tables(db)).toEqual([]);
    db.close();
  });

  it("doesn't take the write lock when the schema is already current", () => {
    const path = join(tempDir(), "tenzo.db");
    openDatabase(path).close();
    const writer = new DatabaseSync(path);
    writer.exec("PRAGMA busy_timeout = 0");
    writer.exec("BEGIN IMMEDIATE"); // another process mid-write, e.g. the daemon
    try {
      const started = Date.now();
      const db = openDatabase(path); // would wait out busy_timeout (5s) if it wanted the lock
      expect(Date.now() - started).toBeLessThan(1000);
      db.close();
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  it("rebuilds a parent table without cascading into its children", () => {
    const path = join(tempDir(), "tenzo.db");
    const v1: Migration[] = [
      {
        name: "parent and child",
        sql: `CREATE TABLE parent (id TEXT PRIMARY KEY) STRICT;
              CREATE TABLE child (id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE) STRICT;`,
      },
    ];
    const first = openDatabase(path, v1);
    first.exec("INSERT INTO parent VALUES ('p'); INSERT INTO child VALUES ('c', 'p');");
    first.close();

    // SQLite's 12-step rebuild: with foreign keys on, DROP TABLE parent would delete the child.
    const rebuild: Migration = {
      name: "add a column the hard way",
      sql: `CREATE TABLE parent_new (id TEXT PRIMARY KEY, label TEXT) STRICT;
            INSERT INTO parent_new (id) SELECT id FROM parent;
            DROP TABLE parent;
            ALTER TABLE parent_new RENAME TO parent;`,
    };
    const db = openDatabase(path, [...v1, rebuild]);
    expect(db.prepare("SELECT id, parent_id FROM child").all()).toEqual([
      { id: "c", parent_id: "p" },
    ]);
    expect(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    db.close();
  });

  it("rolls back a migration that leaves broken foreign keys", () => {
    const path = join(tempDir(), "tenzo.db");
    const v1: Migration[] = [
      {
        name: "parent and child",
        sql: `CREATE TABLE parent (id TEXT PRIMARY KEY) STRICT;
              CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id)) STRICT;`,
      },
    ];
    openDatabase(path, v1).close();
    const orphaning: Migration = { name: "orphan", sql: "INSERT INTO child VALUES ('c', 'nope')" };
    expect(() => openDatabase(path, [...v1, orphaning])).toThrow(/broken foreign key/);
    const db = openDatabase(path, v1);
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT * FROM child").all()).toEqual([]);
    db.close();
  });

  it("gives threads from before agent sessions an empty session, keeping them", () => {
    const path = join(tempDir(), "tenzo.db");
    const first = openDatabase(path, MIGRATIONS.slice(0, 1));
    first.exec(`
      INSERT INTO projects VALUES ('prj_1', 'app', '/r/app', 'main', 'now');
      INSERT INTO threads (id, project_id, title, slug, branch, worktree_path, status, created_at, updated_at)
        VALUES ('thr_1', 'prj_1', 'Old', 'old', 'tenzo/old', '/w/old', 'active', 'now', 'now');
    `);
    first.close();
    const db = openDatabase(path);
    expect(db.prepare("SELECT id, title, agent, session_id FROM threads").all()).toEqual([
      { id: "thr_1", title: "Old", agent: null, session_id: null },
    ]);
    db.close();
  });

  it("gives threads from before the discuss step a phase: building if they ever ran", () => {
    const path = join(tempDir(), "tenzo.db");
    const phase = MIGRATIONS.findIndex((m) => m.name === "thread phase");
    const before = openDatabase(path, MIGRATIONS.slice(0, phase));
    before.exec(`
      INSERT INTO projects (id, name, path, default_branch, created_at)
        VALUES ('prj_1', 'app', '/r/app', 'main', 'now');
      INSERT INTO threads (id, project_id, title, slug, branch, worktree_path, status, created_at, updated_at, session_id)
        VALUES ('thr_1', 'prj_1', 'Ran', 'ran', 'tenzo/ran', '/w/ran', 'active', 'now', 'now', 'sess-1'),
               ('thr_2', 'prj_1', 'New', 'new', 'tenzo/new', '/w/new', 'active', 'now', 'now', NULL);
    `);
    before.close();
    const db = openDatabase(path);
    expect(db.prepare("SELECT id, phase FROM threads ORDER BY id").all()).toEqual([
      { id: "thr_1", phase: "building" },
      { id: "thr_2", phase: "discussing" },
    ]);
    db.close();
  });

  it("gives threads from before finished work no attachments and no live app", () => {
    const path = join(tempDir(), "tenzo.db");
    const finished = MIGRATIONS.findIndex((m) => m.name === "finished work");
    const before = openDatabase(path, MIGRATIONS.slice(0, finished));
    before.exec(`
      INSERT INTO projects (id, name, path, default_branch, created_at)
        VALUES ('prj_1', 'app', '/r/app', 'main', 'now');
      INSERT INTO threads (id, project_id, title, slug, branch, worktree_path, status, created_at, updated_at)
        VALUES ('thr_1', 'prj_1', 'Ran', 'ran', 'tenzo/ran', '/w/ran', 'active', 'now', 'now');
    `);
    before.close();
    const db = openDatabase(path);
    expect(db.prepare("SELECT attachments, preview FROM threads").all()).toEqual([
      { attachments: "[]", preview: null },
    ]);
    db.close();
  });

  it("gives threads from before landing no wake, and you as their origin", () => {
    const path = join(tempDir(), "tenzo.db");
    const landing = MIGRATIONS.findIndex((m) => m.name === "landing and agent threads");
    const before = openDatabase(path, MIGRATIONS.slice(0, landing));
    before.exec(`
      INSERT INTO projects (id, name, path, default_branch, created_at)
        VALUES ('prj_1', 'app', '/r/app', 'main', 'now');
      INSERT INTO threads (id, project_id, title, slug, branch, worktree_path, status, created_at, updated_at)
        VALUES ('thr_1', 'prj_1', 'Ran', 'ran', 'tenzo/ran', '/w/ran', 'active', 'now', 'now');
    `);
    before.close();
    const db = openDatabase(path);
    expect(db.prepare("SELECT wake, origin, parent_id FROM threads").all()).toEqual([
      { wake: null, origin: "user", parent_id: null },
    ]);
    // Children are counted by parent, landed threads found by event type.
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('threads_by_parent', 'events_by_type') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "events_by_type" }, { name: "threads_by_parent" }]);
    db.close();
  });

  it("keeps the log append-only", () => {
    const db = openDatabase(join(tempDir(), "tenzo.db"));
    db.exec(`
      INSERT INTO projects (id, name, path, default_branch, created_at) VALUES ('prj_1', 'app', '/r', 'main', 'now');
      INSERT INTO threads (id, project_id, title, slug, branch, worktree_path, status, created_at, updated_at)
        VALUES ('thr_1', 'prj_1', 'T', 't', 'tenzo/t', '/w', 'active', 'now', 'now');
      INSERT INTO events (id, environment_id, thread_id, type, created_at, body)
        VALUES ('evt_1', 'env_1', 'thr_1', 'runtime.error', 'now', '{}');
    `);
    expect(() => db.exec("UPDATE events SET type = 'x'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM events")).toThrow(/append-only/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(1);
    db.close();
  });

  it("gives older threads and projects room for the event store, keeping them", () => {
    const path = join(tempDir(), "tenzo.db");
    const first = openDatabase(path, MIGRATIONS.slice(0, 2));
    first.exec(`
      INSERT INTO projects VALUES ('prj_1', 'app', '/r/app', 'main', 'now');
      INSERT INTO threads (id, project_id, title, slug, branch, worktree_path, status, created_at, updated_at, agent, session_id)
        VALUES ('thr_1', 'prj_1', 'Old', 'old', 'tenzo/old', '/w/old', 'active', 'now', 'now', 'claude', 's-1');
    `);
    first.close();
    const db = openDatabase(path);
    expect(
      db.prepare("SELECT session_id, model, live, turn_id, context, environment_id FROM threads").all(),
    ).toEqual([
      { session_id: "s-1", model: null, live: 0, turn_id: null, context: "", environment_id: null },
    ]);
    expect(db.prepare("SELECT removed_at FROM projects").all()).toEqual([{ removed_at: null }]);
    db.close();
  });

  it("refuses a database from a newer tenzo instead of guessing", () => {
    const path = join(tempDir(), "tenzo.db");
    openDatabase(path).close();
    expect(() => openDatabase(path, MIGRATIONS.slice(0, MIGRATIONS.length - 1))).toThrow(
      /newer than this tenzo/,
    );
  });
});
