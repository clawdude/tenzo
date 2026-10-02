import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { lockHome } from "./home.ts";
import { removeTempDirs, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

/** A pid that was just used and is no longer running. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(child.stdout);
}

describe("lockHome", () => {
  it("writes our pid, refuses a second lock, and removes it on release", () => {
    const home = tempDir("home");
    const release = lockHome(home);
    expect(readFileSync(join(home, "daemon.pid"), "utf8").trim()).toBe(String(process.pid));
    expect(() => lockHome(home)).toThrow(/Another tenzo daemon/);
    release();
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);
    lockHome(home)();
  });

  it("refuses while the pid in the lock is running, and says how to clear a wrong lock", () => {
    const home = tempDir("home");
    writeFileSync(join(home, "daemon.pid"), `${process.ppid}\n`);
    expect(() => lockHome(home)).toThrow(
      new RegExp(`pid ${process.ppid}.*If no tenzo daemon is running.*delete ${join(home, "daemon.pid")}`),
    );
    expect(readFileSync(join(home, "daemon.pid"), "utf8").trim()).toBe(String(process.ppid));
  });

  it("takes over a lock left by a daemon that died, or one holding garbage, leaving no strays", () => {
    for (const content of [`${deadPid()}\n`, "not a pid", ""]) {
      const home = tempDir("home");
      writeFileSync(join(home, "daemon.pid"), content);
      const release = lockHome(home);
      expect(readFileSync(join(home, "daemon.pid"), "utf8").trim()).toBe(String(process.pid));
      expect(readdirSync(home).filter((f) => f.startsWith("daemon.pid"))).toEqual(["daemon.pid"]);
      release();
    }
  });
});
