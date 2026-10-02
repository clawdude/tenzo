import { describe, expect, it } from "vitest";
import { createApp, VERSION } from "./app.ts";
import { DEFAULT_PORT, readConfig } from "./config.ts";

describe("readConfig", () => {
  it("defaults to loopback on the default port", () => {
    expect(readConfig({})).toEqual({ host: "127.0.0.1", port: DEFAULT_PORT });
    expect(readConfig({ TENZO_PORT: "" }).port).toBe(DEFAULT_PORT);
  });

  it("takes TENZO_PORT when valid and rejects anything else", () => {
    expect(readConfig({ TENZO_PORT: "5000" }).port).toBe(5000);
    expect(() => readConfig({ TENZO_PORT: "abc" })).toThrow(/TENZO_PORT/);
    expect(() => readConfig({ TENZO_PORT: "0" })).toThrow(/TENZO_PORT/);
    expect(() => readConfig({ TENZO_PORT: "70000" })).toThrow(/TENZO_PORT/);
    expect(() => readConfig({ TENZO_PORT: "80.5" })).toThrow(/TENZO_PORT/);
  });
});

describe("createApp", () => {
  it("answers on / with its name and version", async () => {
    const res = await createApp().request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`tenzo daemon ${VERSION}\n`);
  });

  it("returns 404 for unknown routes", async () => {
    expect((await createApp().request("/nope")).status).toBe(404);
  });
});
