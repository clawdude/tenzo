import { join } from "node:path";
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
    expect(tables(db)).toEqual(["projects", "threads"]);
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

  it("refuses a database from a newer tenzo instead of guessing", () => {
    const path = join(tempDir(), "tenzo.db");
    openDatabase(path).close();
    expect(() => openDatabase(path, MIGRATIONS.slice(0, MIGRATIONS.length - 1))).toThrow(
      /newer than this tenzo/,
    );
  });
});
