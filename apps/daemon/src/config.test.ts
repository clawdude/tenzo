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
});
