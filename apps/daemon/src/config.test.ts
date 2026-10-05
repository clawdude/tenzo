import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, readConfig } from "./config.ts";

describe("readConfig", () => {
  it("defaults to loopback, the default port, ~/.tenzo and the web build", () => {
    const config = readConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.home).toBe(join(homedir(), ".tenzo"));
    expect(config.webDir).toMatch(/apps[/\\]web[/\\]build$/);
    expect(readConfig({ TENZO_PORT: "" }).port).toBe(DEFAULT_PORT);
  });

  it("takes TENZO_PORT when valid and rejects anything else", () => {
    expect(readConfig({ TENZO_PORT: "5000" }).port).toBe(5000);
    expect(() => readConfig({ TENZO_PORT: "abc" })).toThrow(/TENZO_PORT/);
    expect(() => readConfig({ TENZO_PORT: "0" })).toThrow(/TENZO_PORT/);
    expect(() => readConfig({ TENZO_PORT: "70000" })).toThrow(/TENZO_PORT/);
    expect(() => readConfig({ TENZO_PORT: "80.5" })).toThrow(/TENZO_PORT/);
  });

  it("takes TENZO_HOME and TENZO_WEB_DIR", () => {
    const config = readConfig({ TENZO_HOME: "/tmp/th", TENZO_WEB_DIR: "/tmp/web" });
    expect(config.home).toBe("/tmp/th");
    expect(config.webDir).toBe("/tmp/web");
  });

  it("takes extra allowed host names from TENZO_ALLOWED_HOSTS", () => {
    expect(readConfig({}).allowedHosts).toEqual([]);
    expect(
      readConfig({ TENZO_ALLOWED_HOSTS: " Mac.tail6259b4.ts.net, other.local ," }).allowedHosts,
    ).toEqual(["mac.tail6259b4.ts.net", "other.local"]);
    expect(() => readConfig({ TENZO_ALLOWED_HOSTS: "https://mac.ts.net" })).toThrow(
      /TENZO_ALLOWED_HOSTS/,
    );
    expect(() => readConfig({ TENZO_ALLOWED_HOSTS: "mac.ts.net:443" })).toThrow(/no scheme or port/);
  });

  it("takes dev server origins from TENZO_DEV_ORIGIN, exact origins only", () => {
    expect(readConfig({}).devOrigins).toEqual([]);
    expect(
      readConfig({ TENZO_DEV_ORIGIN: "http://localhost:5173, http://127.0.0.1:5173/" }).devOrigins,
    ).toEqual(["http://localhost:5173", "http://127.0.0.1:5173"]);
    for (const bad of ["localhost:5173", "http://localhost:5173/app", "file:///x", "*"]) {
      expect(() => readConfig({ TENZO_DEV_ORIGIN: bad }), bad).toThrow(/TENZO_DEV_ORIGIN/);
    }
  });

  it("makes a relative TENZO_HOME absolute, so worktrees can't land inside a repo", () => {
    const config = readConfig({ TENZO_HOME: "relhome", TENZO_WEB_DIR: "web" });
    expect(config.home).toBe(join(process.cwd(), "relhome"));
    expect(config.webDir).toBe(join(process.cwd(), "web"));
  });

  it("puts live apps on the next port unless TENZO_LIVE_PORT says otherwise", () => {
    expect(readConfig({}).livePort).toBe(DEFAULT_PORT + 1);
    expect(readConfig({ TENZO_PORT: "4809" }).livePort).toBe(4810);
    expect(readConfig({ TENZO_LIVE_PORT: "5000" }).livePort).toBe(5000);
    expect(() => readConfig({ TENZO_LIVE_PORT: "x" })).toThrow(/TENZO_LIVE_PORT/);
    expect(() => readConfig({ TENZO_PORT: "5000", TENZO_LIVE_PORT: "5000" })).toThrow(
      /other than TENZO_PORT/,
    );
    expect(() => readConfig({ TENZO_PORT: "65535" })).toThrow(/TENZO_LIVE_PORT/);
  });

  it("takes the live listener's public origins from TENZO_LIVE_ORIGIN", () => {
    expect(readConfig({}).liveOrigins).toEqual([]);
    expect(
      readConfig({ TENZO_LIVE_ORIGIN: "https://mac.tail6259b4.ts.net:8444/" }).liveOrigins,
    ).toEqual(["https://mac.tail6259b4.ts.net:8444"]);
    expect(() => readConfig({ TENZO_LIVE_ORIGIN: "mac.ts.net:8444" })).toThrow(/TENZO_LIVE_ORIGIN/);
  });

  it("takes a default model for threads from TENZO_DEFAULT_MODEL", () => {
    expect(readConfig({}).defaultModel).toBeUndefined();
    expect(readConfig({ TENZO_DEFAULT_MODEL: " " }).defaultModel).toBeUndefined();
    expect(readConfig({ TENZO_DEFAULT_MODEL: " haiku " }).defaultModel).toBe("haiku");
  });

  it("takes a snooze length from TENZO_SNOOZE_MS, for trying snooze out", () => {
    expect(readConfig({}).snoozeMs).toBeUndefined();
    expect(readConfig({ TENZO_SNOOZE_MS: "20000" }).snoozeMs).toBe(20_000);
    for (const bad of ["0", "999", "1.5", "soon", String(25 * 60 * 60_000)]) {
      expect(() => readConfig({ TENZO_SNOOZE_MS: bad })).toThrow(/TENZO_SNOOZE_MS/);
    }
  });

  it("takes how much a notification says, and who sends them", () => {
    expect(readConfig({}).pushPreview).toBeUndefined();
    expect(readConfig({ TENZO_PUSH_PREVIEW: "none" }).pushPreview).toBe("none");
    expect(() => readConfig({ TENZO_PUSH_PREVIEW: "full" })).toThrow(/TENZO_PUSH_PREVIEW/);
    expect(readConfig({}).pushContact).toBeUndefined();
    expect(readConfig({ TENZO_PUSH_CONTACT: "mailto:me@example.com" }).pushContact).toBe(
      "mailto:me@example.com",
    );
    for (const bad of ["me@example.com", "http://example.com"]) {
      expect(() => readConfig({ TENZO_PUSH_CONTACT: bad })).toThrow(/TENZO_PUSH_CONTACT/);
    }
  });
});
