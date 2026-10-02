import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvironmentId } from "@tenzo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateEnvironmentId, loadEnvironmentId } from "./environment.ts";

// Lets a test make the id write fail halfway, as a full disk would.
const failWrite = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      fs.writeFileSync(...args);
      if (failWrite.on) throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
    },
  };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tenzo-env-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadEnvironmentId", () => {
  it("creates the home dir and an id file on first run", () => {
    const home = join(dir, "nested", ".tenzo");
    const id = loadEnvironmentId(home);
    expect(EnvironmentId.safeParse(id).success).toBe(true);
    expect(readFileSync(join(home, "environment-id"), "utf8")).toBe(`${id}\n`);
    expect(readdirSync(home)).toEqual(["environment-id"]); // no temp files left behind
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("cleans up its temp file when the write fails", () => {
    failWrite.on = true;
    try {
      expect(() => loadEnvironmentId(dir)).toThrow(/ENOSPC/);
    } finally {
      failWrite.on = false;
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it("returns the same id on every later run", () => {
    const first = loadEnvironmentId(dir);
    expect(loadEnvironmentId(dir)).toBe(first);
    expect(loadEnvironmentId(dir)).toBe(first);
  });

  it("keeps an id written by someone else", () => {
    writeFileSync(join(dir, "environment-id"), "env_abcdefghij0123456789\n");
    expect(loadEnvironmentId(dir)).toBe("env_abcdefghij0123456789");
  });

  it("refuses to replace a corrupt id file", () => {
    writeFileSync(join(dir, "environment-id"), "not-an-id\n");
    expect(() => loadEnvironmentId(dir)).toThrow(/not an environment id/);
    expect(readFileSync(join(dir, "environment-id"), "utf8")).toBe("not-an-id\n");
  });
});

describe("generateEnvironmentId", () => {
  it("matches the contract and does not repeat", () => {
    const ids = new Set(Array.from({ length: 200 }, generateEnvironmentId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(EnvironmentId.safeParse(id).success).toBe(true);
  });
});
