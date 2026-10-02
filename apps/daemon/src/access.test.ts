import { describe, expect, it } from "vitest";
import { hostAllowed, originAllowed } from "./access.ts";

const none = { allowedHosts: [] };
const tailnet = { allowedHosts: ["andreas-mac-mini.tail6259b4.ts.net"] };
const dev = { allowedHosts: [], devOrigins: ["http://localhost:5173"] };

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

describe("originAllowed (cross-site requests, WebSockets included)", () => {
  it("lets requests without an Origin through: they are not from a web page", () => {
    expect(originAllowed(undefined, "127.0.0.1:4780", none)).toBe(true);
  });

  it("allows the daemon's own page: exactly the host and port the request came in on", () => {
    expect(originAllowed("http://127.0.0.1:4780", "127.0.0.1:4780", none)).toBe(true);
    expect(originAllowed("http://localhost:4780", "localhost:4780", none)).toBe(true);
    expect(originAllowed("http://[::1]:4780", "[::1]:4780", none)).toBe(true);
  });

  it("refuses other localhost ports: another dev server, a local tool's page", () => {
    expect(originAllowed("http://localhost:3000", "127.0.0.1:4780", none)).toBe(false);
    expect(originAllowed("http://127.0.0.1:3000", "127.0.0.1:4780", none)).toBe(false);
    expect(originAllowed("http://localhost:4780", "127.0.0.1:4780", none)).toBe(false);
    expect(originAllowed("https://127.0.0.1:4780", "127.0.0.1:4780", none)).toBe(false);
  });

  it("allows a configured dev origin exactly, and nothing near it", () => {
    expect(originAllowed("http://localhost:5173", "localhost:5173", dev)).toBe(true);
    expect(originAllowed("http://localhost:5173", "127.0.0.1:4780", dev)).toBe(true);
    expect(originAllowed("http://localhost:5174", "127.0.0.1:4780", dev)).toBe(false);
    expect(originAllowed("http://localhost:5173", "127.0.0.1:4780", none)).toBe(false);
  });

  it("allows configured hosts over https only", () => {
    const host = "andreas-mac-mini.tail6259b4.ts.net";
    expect(originAllowed(`https://${host}`, host, tailnet)).toBe(true);
    expect(originAllowed(`http://${host}`, host, tailnet)).toBe(false);
    expect(originAllowed(`https://${host}:8443`, host, tailnet)).toBe(false);
    expect(originAllowed(`https://${host}`, host, none)).toBe(false);
  });

  it("refuses other sites, null origins and other schemes", () => {
    for (const origin of [
      "https://evil.example",
      "http://localhost.evil.example",
      "null",
      "file://",
      "chrome-extension://abc",
      "not a url",
    ]) {
      expect(originAllowed(origin, "127.0.0.1:4780", tailnet), origin).toBe(false);
    }
  });
});
