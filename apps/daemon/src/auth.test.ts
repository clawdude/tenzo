import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deviceCookie,
  FORWARDING_HEADERS,
  fromOwnPage,
  hashToken,
  isLoopbackAddress,
  liveCookie,
  newToken,
  RateLimit,
  readCookie,
  readCookies,
  readLivePass,
  type RequestFacts,
  requestMode,
  setsTenzoCookie,
  signLivePass,
  withoutTenzoCookies,
} from "./auth.ts";

const TS = "my-mac.tail0000.ts.net";

function facts(peer: string | undefined, host: string | undefined, headers: Record<string, string> = {}): RequestFacts {
  return { peer, host, header: (name) => headers[name] };
}

describe("local or remote", () => {
  it("is local only from this Mac: loopback socket, loopback Host, no proxy", () => {
    for (const host of ["127.0.0.1:4780", "localhost:4780", "[::1]:4780", "LOCALHOST", "localhost.:4780"]) {
      expect(requestMode(facts("127.0.0.1", host)), host).toBe("local");
    }
    expect(requestMode(facts("::1", "localhost:4780"))).toBe("local");
    expect(requestMode(facts("::ffff:127.0.0.1", "127.0.0.1:4780"))).toBe("local");
    expect(requestMode(facts("127.8.9.10", "127.0.0.1"))).toBe("local");
  });

  it("is remote through Tailscale Serve: it connects from loopback, but names the tailnet host", () => {
    const serve = { "x-forwarded-for": "100.64.0.7", "x-forwarded-host": `${TS}:8443`, "x-forwarded-proto": "https" };
    expect(requestMode(facts("127.0.0.1", `${TS}:8443`, serve))).toBe("remote");
    // An allowed non-loopback Host is remote whatever socket it came in on, headers or not.
    expect(requestMode(facts("127.0.0.1", TS))).toBe("remote");
    expect(requestMode(facts("127.0.0.1", "pair.test:4940"))).toBe("remote");
  });

  it("can't be talked into local by a device elsewhere", () => {
    // A phone that sends Host: localhost through the proxy still carries the proxy's headers.
    for (const name of FORWARDING_HEADERS) {
      expect(requestMode(facts("127.0.0.1", "localhost:4780", { [name]: "x" })), name).toBe("remote");
    }
    // Not from loopback at all, whatever it claims.
    expect(requestMode(facts("100.64.0.7", "localhost:4780"))).toBe("remote");
    expect(requestMode(facts("192.168.1.20", "127.0.0.1:4780"))).toBe("remote");
    expect(requestMode(facts("::ffff:10.0.0.1", "127.0.0.1"))).toBe("remote");
    // Look-alikes of loopback names and addresses.
    expect(requestMode(facts("127.0.0.1", "localhost.evil.example"))).toBe("remote");
    expect(requestMode(facts("127.0.0.1", "127.0.0.1.nip.io"))).toBe("remote");
    expect(requestMode(facts("1270.0.0.1", "127.0.0.1"))).toBe("remote");
    // Unknown is remote: fail closed.
    expect(requestMode(facts(undefined, "127.0.0.1"))).toBe("remote");
    expect(requestMode(facts("127.0.0.1", undefined))).toBe("remote");
    expect(requestMode(facts("127.0.0.1", "not a host"))).toBe("remote");
  });

  it("knows loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    for (const address of ["128.0.0.1", "::2", "0.0.0.0", "", undefined, "127.0.0.1x"]) {
      expect(isLoopbackAddress(address), String(address)).toBe(false);
    }
  });
});

describe("cookies", () => {
  it("keeps the device's token in a cookie no page can read or carry elsewhere", () => {
    const cookie = deviceCookie("tok");
    expect(cookie.startsWith("__Host-tenzo=tok;")).toBe(true);
    for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"]) {
      expect(cookie.split("; "), attribute).toContain(attribute);
    }
    expect(cookie).not.toMatch(/Domain=/i);
    expect(liveCookie("pass", 10_000, 0).split("; ")).toEqual(
      expect.arrayContaining(["__Host-tenzo-live=pass", "Path=/", "Secure", "HttpOnly", "SameSite=Strict"]),
    );
    // The cookie lives no longer than the pass in it.
    expect(liveCookie("pass", 10_999, 0)).toContain("Max-Age=10;");
    expect(liveCookie("pass", 0, 5_000)).toContain("Max-Age=0;");
  });

  it("reads every value under a name, so a planted one can't shadow ours", () => {
    expect(readCookies("__Host-tenzo=bad; a=1; __Host-tenzo=good", "__Host-tenzo")).toEqual(["bad", "good"]);
    expect(readCookies("a=1", "__Host-tenzo")).toEqual([]);
  });

  it("reads one cookie by its exact name", () => {
    const header = "a=1; __Host-tenzo-live=L; __Host-tenzo=D; b=2";
    expect(readCookie(header, "__Host-tenzo")).toBe("D");
    expect(readCookie(header, "__Host-tenzo-live")).toBe("L");
    expect(readCookie("__host-tenzo=x", "__Host-tenzo")).toBeNull();
    expect(readCookie(undefined, "__Host-tenzo")).toBeNull();
    // Several Cookie headers joined by a comma: still found.
    expect(readCookie("a=1, __Host-tenzo=D", "__Host-tenzo")).toBe("D");
  });

  it("strips Tenzo's cookies, and only those, before a dev server sees the request", () => {
    expect(withoutTenzoCookies("a=1; __Host-tenzo=D; __Host-tenzo-live=L; b=2")).toBe("a=1; b=2");
    expect(withoutTenzoCookies("__Host-tenzo=D")).toBeNull();
    expect(withoutTenzoCookies("a=1, __Host-tenzo=D")).toBe("a=1");
    expect(withoutTenzoCookies("__HOST-TENZO=D; x=__Host-tenzo")).toBe("x=__Host-tenzo");
    expect(withoutTenzoCookies(undefined)).toBeNull();
  });

  it("knows a Set-Cookie for Tenzo's cookies, which a dev server may not send", () => {
    expect(setsTenzoCookie("__Host-tenzo=evil; Path=/; Secure")).toBe(true);
    expect(setsTenzoCookie("__host-tenzo-live=x")).toBe(true);
    expect(setsTenzoCookie("session=abc; Path=/")).toBe(false);
    expect(setsTenzoCookie("__Host-tenzo-other=1")).toBe(false);
    // Nameless: some browsers store `=__Host-tenzo=x` as `__Host-tenzo=x`.
    expect(setsTenzoCookie("=__Host-tenzo=x; Path=/")).toBe(true);
    expect(setsTenzoCookie(" = __host-tenzo-live=x")).toBe(true);
    expect(setsTenzoCookie("=plain")).toBe(false);
  });

  it("takes the device cookie from Tenzo's own pages only", () => {
    expect(fromOwnPage(undefined)).toBe(true);
    expect(fromOwnPage("same-origin")).toBe(true);
    expect(fromOwnPage("none")).toBe(true);
    // A live page is same-site (cookies ignore ports) but another origin.
    expect(fromOwnPage("same-site")).toBe(false);
    expect(fromOwnPage("cross-site")).toBe(false);
  });
});

describe("tokens", () => {
  it("are long, random, and kept only as a hash", () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toContain(a);
  });

  it("live passes name a device until they expire, and only with Tenzo's key", () => {
    const key = randomBytes(32);
    const device = "dev_aaaaaaaaaaaaaaaaaaaa";
    const pass = signLivePass(key, device, 2_000);
    expect(readLivePass(key, pass, 1_000)).toBe(device);
    expect(readLivePass(key, pass, 2_000)).toBeNull();
    expect(readLivePass(randomBytes(32), pass, 1_000)).toBeNull();
    const [id, , sig] = pass.split(".");
    expect(readLivePass(key, `${id}.9999999.${sig}`, 1_000)).toBeNull(); // a longer life, forged
    expect(readLivePass(key, `dev_bbbbbbbbbbbbbbbbbbbb.2000.${sig}`, 1_000)).toBeNull();
    for (const junk of ["", "x", "a.b.c.d", null, undefined]) {
      expect(readLivePass(key, junk, 1_000), String(junk)).toBeNull();
    }
  });
});

describe("rate limit", () => {
  it("counts failures per window, for everyone together, until reset", () => {
    let now = 0;
    const limit = new RateLimit(3, 60_000, () => now);
    expect(limit.blocked()).toBe(false);
    limit.fail();
    limit.fail();
    expect(limit.blocked()).toBe(false);
    limit.fail();
    expect(limit.blocked()).toBe(true);
    expect(limit.retryAfter()).toBe(60);
    now = 59_999;
    expect(limit.blocked()).toBe(true);
    now = 60_000;
    expect(limit.blocked()).toBe(false);
    for (let i = 0; i < 3; i++) limit.fail();
    expect(limit.blocked()).toBe(true);
    limit.reset();
    expect(limit.blocked()).toBe(false);
    expect(limit.retryAfter()).toBe(0);
  });
});
