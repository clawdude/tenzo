import { describe, expect, it } from "vitest";
import {
  assertSafeServe,
  loopbackPort,
  parseServeStatus,
  parseStatus,
  planServe,
  serveCommand,
  UnreadableServeStatus,
  type ServeRoute,
} from "./tailscale.ts";
import { NAME, SERVE_SET_UP, SERVE_UNRELATED, STATUS_1_102, STATUS_OLD } from "./tailscale-fixtures.ts";

const plan = (routes: ServeRoute[], extra: { httpsPort?: number; liveHttpsPort?: number } = {}) =>
  planServe(routes, { dnsName: NAME, daemonPort: 4780, livePort: 4781, ...extra });
const serve = (config: unknown) => parseServeStatus(JSON.stringify(config));

describe("parseStatus", () => {
  it("reads the node's MagicDNS name, lower case without the dot, and whether HTTPS is on", () => {
    expect(parseStatus(JSON.stringify(STATUS_1_102))).toEqual({ dnsName: NAME, https: true });
    expect(parseStatus(JSON.stringify(STATUS_OLD))).toEqual({ dnsName: NAME, https: true });
    const noCerts = { ...STATUS_1_102, CertDomains: null, Self: { ...STATUS_1_102.Self, Capabilities: [] } };
    expect(parseStatus(JSON.stringify(noCerts))).toEqual({ dnsName: NAME, https: false });
  });

  it("says what to do when the node can't serve", () => {
    for (const state of ["NeedsLogin", "Stopped", "NoState"]) {
      expect(() => parseStatus(JSON.stringify({ BackendState: state, Self: { DNSName: "" } }))).toThrow(
        /tailscale up/,
      );
    }
    const noDns = { ...STATUS_1_102, Self: { ...STATUS_1_102.Self, DNSName: "" } };
    expect(() => parseStatus(JSON.stringify(noDns))).toThrow(/MagicDNS/);
    const off = { ...STATUS_1_102, CurrentTailnet: { MagicDNSEnabled: false } };
    expect(() => parseStatus(JSON.stringify(off))).toThrow(/MagicDNS/);
    expect(() => parseStatus("tailscaled is not running")).toThrow(/not JSON/);
  });

  it("refuses a name that isn't a plain host name: it goes into commands, settings and a plist", () => {
    for (const odd of [
      "my mac.tail1234.ts.net",
      "my-mac.tail1234.ts.net;rm -rf ~",
      "my-mac.tail1234.ts.net:8443",
      "my_mac.tail1234.ts.net",
      "<x>.ts.net",
      "-mac.tail1234.ts.net",
      "mac..ts.net",
      "localhost",
      "mäc.ts.net",
    ]) {
      const status = { ...STATUS_1_102, Self: { ...STATUS_1_102.Self, DNSName: `${odd}.` } };
      expect(() => parseStatus(JSON.stringify(status)), odd).toThrow(/isn't a host name Tenzo can use/);
    }
  });
});

describe("parseServeStatus", () => {
  it("reads nothing served as no routes, however it is said", () => {
    expect(parseServeStatus("")).toEqual([]);
    expect(parseServeStatus("null\n")).toEqual([]);
    expect(parseServeStatus("{}")).toEqual([]);
  });

  it("reads HTTPS routes with their handlers", () => {
    expect(serve(SERVE_SET_UP)).toEqual([
      { port: 443, kind: "https", handlers: { "/": "http://127.0.0.1:18789" }, tcpForward: null, funnel: false, foreground: false },
      { port: 8443, kind: "https", handlers: { "/": "http://127.0.0.1:4780" }, tcpForward: null, funnel: false, foreground: false },
      { port: 8444, kind: "https", handlers: { "/": "http://127.0.0.1:4781" }, tcpForward: null, funnel: false, foreground: false },
    ]);
  });

  it("reads raw TCP, TLS-terminated TCP, plain HTTP, Funnel, foreground serves and other handlers", () => {
    const routes = serve({
      TCP: {
        "22": { TCPForward: "127.0.0.1:22" },
        "5432": { TCPForward: "127.0.0.1:5432", TerminateTLS: NAME },
        "80": { HTTP: true },
        "443": { HTTPS: true },
      },
      Web: {
        [`${NAME}:80`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
        [`${NAME}:443`]: {
          Handlers: { "/": { Path: "/var/www" }, "/api": { Proxy: "http://127.0.0.1:9000" }, "/hi": { Text: "hi" } },
        },
      },
      AllowFunnel: { [`${NAME}:443`]: true },
      Foreground: {
        abc123: {
          TCP: { "10000": { HTTPS: true } },
          Web: { [`${NAME}:10000`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:7000" } } } },
        },
      },
      // Tailscale Services have an address of their own: no port of the node's.
      Services: { "svc:web": { TCP: { "443": { HTTPS: true } } } },
    });
    expect(routes.map((r) => [r.port, r.kind, r.tcpForward, r.funnel, r.foreground])).toEqual([
      [22, "tcp", "127.0.0.1:22", false, false],
      [80, "http", null, false, false],
      [443, "https", null, true, false],
      [5432, "tls-terminated-tcp", "127.0.0.1:5432", false, false],
      [10000, "https", null, false, true],
    ]);
    expect(routes[2]?.handlers).toEqual({ "/": "path:/var/www", "/api": "http://127.0.0.1:9000", "/hi": "text" });
  });

  it("fails clearly on output that isn't JSON", () => {
    expect(() => parseServeStatus("No serve config")).toThrow(UnreadableServeStatus);
    expect(() => parseServeStatus("No serve config")).toThrow(/not JSON/);
  });

  // Read as "nothing served", any of these would let the plan put Tenzo over someone's route.
  it("refuses a top level that isn't null or an object", () => {
    for (const json of ["[]", '"x"', "42", "true", '[{"TCP":{}}]']) {
      expect(() => parseServeStatus(json), json).toThrow(/the top level isn't an object/);
    }
  });

  it("refuses an object with none of the keys it knows, but takes unknown keys beside them", () => {
    expect(() => parseServeStatus(JSON.stringify({ Tcp: { "8443": { HTTPS: true } } }))).toThrow(
      /the top level has none of TCP, Web/,
    );
    expect(() => parseServeStatus(JSON.stringify({ Ports: [8443] }))).toThrow(UnreadableServeStatus);
    expect(serve({ ...SERVE_UNRELATED, Version: 2 }).map((r) => r.port)).toEqual([443]);
    // Services alone is a known shape: nothing on the node's own ports.
    expect(serve({ Services: { "svc:web": { TCP: { "443": { HTTPS: true } } } } })).toEqual([]);
  });

  it("refuses maps that aren't objects", () => {
    for (const config of [
      { TCP: [{ HTTPS: true }] },
      { TCP: "8443" },
      { Web: [] },
      { Web: 1 },
      { AllowFunnel: [] },
      { Foreground: [] },
      { Services: "x" },
    ]) {
      expect(() => serve(config), JSON.stringify(config)).toThrow(/isn't an object/);
    }
  });

  it("refuses entries that aren't objects, or fields of the wrong kind", () => {
    for (const config of [
      { TCP: { "8443": null } },
      { TCP: { "8443": true } },
      { TCP: { "8443": [] } },
      { Web: { [`${NAME}:8443`]: null } },
      { Web: { [`${NAME}:8443`]: { Handlers: [] } } },
      { Web: { [`${NAME}:8443`]: { Handlers: { "/": "http://127.0.0.1:1" } } } },
      { Foreground: { s1: null } },
      { Foreground: { s1: { Nope: 1 } } },
    ]) {
      expect(() => serve(config), JSON.stringify(config)).toThrow(/isn't an object|has none of/);
    }
    expect(() => serve({ TCP: { "8443": { HTTPS: "yes" } } })).toThrow(/HTTPS isn't true or false/);
    expect(() => serve({ TCP: { "22": { TCPForward: 22 } } })).toThrow(/TCPForward isn't text/);
    expect(() => serve({ TCP: { "443": { HTTPS: true } }, AllowFunnel: { [`${NAME}:443`]: "on" } })).toThrow(
      /isn't true or false/,
    );
  });

  it("refuses ports outside 1 to 65535, in TCP, Web and AllowFunnel keys", () => {
    for (const key of ["0", "65536", "99999", "-1", "abc", "8443.5", "", " 8443"]) {
      expect(() => serve({ TCP: { [key]: { HTTPS: true } } }), key).toThrow(/isn't a port/);
      expect(() => serve({ Web: { [`${NAME}:${key}`]: { Handlers: {} } } }), key).toThrow(/isn't a port/);
      expect(() => serve({ AllowFunnel: { [`${NAME}:${key}`]: true } }), key).toThrow(/isn't a port/);
    }
    expect(serve({ TCP: { "1": {}, "65535": { HTTPS: true } } }).map((r) => r.port)).toEqual([1, 65535]);
  });
});

describe("loopbackPort", () => {
  it("takes plain-HTTP loopback targets only", () => {
    expect(loopbackPort("http://127.0.0.1:4780")).toBe(4780);
    expect(loopbackPort("http://127.0.0.1:4780/")).toBe(4780);
    expect(loopbackPort("http://localhost:4780")).toBe(4780);
    expect(loopbackPort("http://[::1]:4780")).toBe(4780);
    expect(loopbackPort("127.0.0.1:4780")).toBe(4780);
    expect(loopbackPort("https+insecure://127.0.0.1:4780")).toBeNull();
    expect(loopbackPort("http://10.0.0.2:4780")).toBeNull();
    expect(loopbackPort("http://127.0.0.1:4780/sub")).toBeNull();
    expect(loopbackPort("http://127.0.0.1")).toBeNull();
  });
});

describe("planServe", () => {
  it("adds both routes on 8443 and 8444 when nothing is served", () => {
    const p = plan([]);
    expect(p.daemon).toEqual({
      role: "daemon",
      httpsPort: 8443,
      localPort: 4780,
      action: "add",
      origin: `https://${NAME}:8443`,
    });
    expect(p.live).toMatchObject({ httpsPort: 8444, localPort: 4781, action: "add", origin: `https://${NAME}:8444` });
    expect(p.untouched).toEqual([]);
  });

  it("leaves an unrelated route alone and lists it", () => {
    const p = plan(serve(SERVE_UNRELATED));
    expect([p.daemon.action, p.daemon.httpsPort, p.live.action, p.live.httpsPort]).toEqual(["add", 8443, "add", 8444]);
    expect(p.untouched.map((r) => r.port)).toEqual([443]);
  });

  it("keeps routes that are already right: running it again changes nothing", () => {
    const p = plan(serve(SERVE_SET_UP));
    expect([p.daemon.action, p.live.action]).toEqual(["keep", "keep"]);
    expect([p.daemon.httpsPort, p.live.httpsPort]).toEqual([8443, 8444]);
    expect(p.untouched.map((r) => r.port)).toEqual([443]);
    expect(p.warnings).toEqual([]);
  });

  it("finds Tenzo's routes on other ports, and spellings of the target", () => {
    const p = plan(
      serve({
        TCP: { "9443": { HTTPS: true }, "443": { HTTPS: true } },
        Web: {
          [`${NAME}:9443`]: { Handlers: { "/": { Proxy: "http://localhost:4780/" } } },
          [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4781" } } },
        },
      }),
    );
    expect([p.daemon.action, p.daemon.httpsPort, p.live.action, p.live.httpsPort]).toEqual(["keep", 9443, "keep", 443]);
    expect(p.live.origin).toBe(`https://${NAME}`);
  });

  it("moves aside from a default port that serves something else, never taking it over", () => {
    const taken = serve({
      TCP: { "8443": { HTTPS: true }, "8444": { TCPForward: "127.0.0.1:22" } },
      Web: { [`${NAME}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
    });
    const p = plan(taken);
    expect([p.daemon.action, p.daemon.httpsPort, p.live.action, p.live.httpsPort]).toEqual(["add", 8445, "add", 8446]);
    expect(p.untouched.map((r) => r.port)).toEqual([8443, 8444]);
    // Only 8443 taken: the Pass doesn't take live's 8444.
    const one = plan(serve({ TCP: { "8443": { HTTPS: true } }, Web: { [`${NAME}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } }));
    expect([one.daemon.httpsPort, one.live.httpsPort]).toEqual([8445, 8444]);
    // A route of a different Tenzo (another TENZO_PORT) is someone else's too.
    const other = plan(serve({ TCP: { "8443": { HTTPS: true } }, Web: { [`${NAME}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4790" } } } } }));
    expect(other.daemon).toMatchObject({ action: "add", httpsPort: 8445 });
    // Plain HTTP to Tenzo isn't usable (the cookie needs HTTPS): taken, not kept.
    const http = plan(serve({ TCP: { "8443": { HTTP: true } }, Web: { [`${NAME}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4780" } } } } }));
    expect(http.daemon).toMatchObject({ action: "add", httpsPort: 8445 });
  });

  it("takes asked-for ports: free ones get a route, Tenzo's are kept, someone else's are an error", () => {
    expect(plan([], { httpsPort: 443, liveHttpsPort: 10000 })).toMatchObject({
      daemon: { httpsPort: 443, action: "add", origin: `https://${NAME}` },
      live: { httpsPort: 10000, action: "add" },
    });
    expect(plan(serve(SERVE_SET_UP), { httpsPort: 8443 }).daemon.action).toBe("keep");
    expect(() => plan(serve(SERVE_SET_UP), { httpsPort: 443 })).toThrow(
      /already serves port 443 \(http:\/\/127\.0\.0\.1:18789\)/,
    );
    expect(() => plan([], { httpsPort: 9000, liveHttpsPort: 9000 })).toThrow(/two different/);
    for (const bad of [0, 65_536, 8443.5]) {
      expect(() => plan([], { httpsPort: bad }), String(bad)).toThrow(/isn't a port/);
      expect(() => plan([], { liveHttpsPort: bad }), String(bad)).toThrow(/isn't a port/);
    }
  });

  it("refuses raw TCP to Tenzo, which would let everyone in as local", () => {
    for (const tcp of [{ TCPForward: "127.0.0.1:4780" }, { TCPForward: "localhost:4781", TerminateTLS: NAME }]) {
      expect(() => plan(serve({ TCP: { "8443": tcp } }))).toThrow(/raw TCP.*no pairing/);
    }
    // Raw TCP to something else is not Tenzo's business.
    expect(() => plan(serve({ TCP: { "2222": { TCPForward: "127.0.0.1:22" } } }))).not.toThrow();
  });

  it("warns about Funnel, foreground serves and extra paths on Tenzo's routes", () => {
    const p = plan(
      serve({
        TCP: { "8443": { HTTPS: true } },
        Web: { [`${NAME}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4780" }, "/x": { Text: "x" } } } },
        AllowFunnel: { [`${NAME}:8443`]: true },
        Foreground: {
          s1: {
            TCP: { "8444": { HTTPS: true } },
            Web: { [`${NAME}:8444`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4781" } } } },
          },
        },
      }),
    );
    expect([p.daemon.action, p.live.action]).toEqual(["keep", "keep"]);
    expect(p.warnings.join("\n")).toMatch(/8443 is on Funnel/);
    expect(p.warnings.join("\n")).toMatch(/8443 also serves \/x/);
    expect(p.warnings.join("\n")).toMatch(/8444 comes from a `tailscale serve` running in the foreground/);
  });
});

describe("serveCommand", () => {
  it("is an HTTPS serve in the background, and nothing else gets through", () => {
    const p = plan([]);
    expect(serveCommand(p.daemon)).toEqual(["serve", "--bg", "--https=8443", "http://127.0.0.1:4780"]);
    expect(serveCommand(p.live)).toEqual(["serve", "--bg", "--https=8444", "http://127.0.0.1:4781"]);
    for (const bad of [
      ["serve", "--bg", "--tcp=8443", "tcp://127.0.0.1:4780"],
      ["serve", "--bg", "--tls-terminated-tcp=8443", "tcp://127.0.0.1:4780"],
      ["serve", "--https=443", "off"],
      ["serve", "reset"],
      ["funnel", "--bg", "--https=443", "http://127.0.0.1:4780"],
      ["serve", "--bg", "--https=8443", "http://example.com:80"],
      ["serve", "--bg", "--https=8443", "http://127.0.0.1:4780", "--set-path=/x"],
      ["serve", "--bg", "--https=0", "http://127.0.0.1:4780"],
      ["serve", "--bg", "--https=65536", "http://127.0.0.1:4780"],
      ["serve", "--bg", "--https=8443", "http://127.0.0.1:70000"],
    ]) {
      expect(() => assertSafeServe(bad)).toThrow(/Refusing/);
    }
  });
});
