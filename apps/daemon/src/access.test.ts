import { describe, expect, it } from "vitest";
import { hostAllowed, originAllowed } from "./access.ts";

const none = { allowedHosts: [] };
const tailnet = { allowedHosts: ["andreas-mac-mini.tail6259b4.ts.net"] };

describe("hostAllowed (DNS rebinding)", () => {
  it("allows loopback names on any port", () => {
    for (const host of ["127.0.0.1:4780", "localhost:4780", "localhost", "[::1]:4780", "LOCALHOST"]) {
      expect(hostAllowed(host, none), host).toBe(true);
    }
  });

  it("refuses any other name, a missing one, and garbage", () => {
    for (const host of [
      "evil.example",
      "evil.example:4780",
      "127.0.0.1.evil.example",
      "localhost.evil.example",
      "192.168.1.5:4780",
      "",
      undefined,
      "a b",
    ]) {
      expect(hostAllowed(host, none), String(host)).toBe(false);
    }
  });

  it("allows configured names, such as the Tailscale Serve host", () => {
    expect(hostAllowed("andreas-mac-mini.tail6259b4.ts.net", tailnet)).toBe(true);
    expect(hostAllowed("Andreas-Mac-Mini.tail6259b4.ts.net.", tailnet)).toBe(true);
    expect(hostAllowed("andreas-mac-mini.tail6259b4.ts.net", none)).toBe(false);
    expect(hostAllowed("other.tail6259b4.ts.net", tailnet)).toBe(false);
  });
});

describe("originAllowed (cross-site requests)", () => {
  it("lets requests without an Origin through: they are not from a web page", () => {
    expect(originAllowed(undefined, none)).toBe(true);
  });

  it("allows our own pages: loopback on any port (the dev server) and configured hosts", () => {
    expect(originAllowed("http://127.0.0.1:4780", none)).toBe(true);
    expect(originAllowed("http://localhost:5173", none)).toBe(true);
    expect(originAllowed("http://[::1]:4780", none)).toBe(true);
    expect(originAllowed("https://andreas-mac-mini.tail6259b4.ts.net", tailnet)).toBe(true);
  });

  it("refuses other sites, null origins and other schemes", () => {
    for (const origin of [
      "https://evil.example",
      "http://localhost.evil.example",
      "https://andreas-mac-mini.tail6259b4.ts.net",
      "null",
      "file://",
      "chrome-extension://abc",
      "not a url",
    ]) {
      expect(originAllowed(origin, none), origin).toBe(false);
    }
  });
});
