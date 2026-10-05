import { join } from "node:path";
import { PAIRING_TTL_MS, pairingCode, pairingUrl } from "@tenzo/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "./auth.ts";
import { Devices, nameFromUserAgent, pairingOrigin } from "./devices.ts";
import { openStore, type Store } from "./store.ts";
import { removeTempDirs, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

let store: Store;
let now: number;
let devices: Devices;

beforeEach(() => {
  store = openStore(join(tempDir("home"), ".tenzo"));
  now = Date.parse("2026-10-05T10:00:00.000Z");
  devices = new Devices(store, { now: () => now });
});
afterEach(() => store.close());

describe("pairing", () => {
  it("trades a code once for a device and its own token", () => {
    const { code, expiresAt } = devices.pair("phone");
    expect(code).toMatch(/^[a-z0-9]{26}$/);
    expect(Date.parse(expiresAt) - now).toBe(PAIRING_TTL_MS);
    const paired = devices.exchange(code, "iPhone");
    expect(paired?.device).toMatchObject({ name: "phone", lastSeenAt: paired?.device.createdAt });
    expect(paired?.device.id).toMatch(/^dev_[a-z0-9]{20}$/);
    expect(devices.authenticate(paired?.token)?.id).toBe(paired?.device.id);
    // Single use: the same code again gets nothing.
    expect(devices.exchange(code, "iPhone")).toBeNull();
    expect(devices.list()).toHaveLength(1);
  });

  it("names the device from its browser when tenzo pair wasn't given a name", () => {
    const { code } = devices.pair();
    expect(devices.exchange(code, "iPad")?.device.name).toBe("iPad");
  });

  it("expires", () => {
    const { code } = devices.pair();
    now += PAIRING_TTL_MS;
    expect(devices.exchange(code, "x")).toBeNull();
    const fresh = devices.pair();
    now += PAIRING_TTL_MS - 1;
    expect(devices.exchange(fresh.code, "x")).not.toBeNull();
  });

  it("knows no other code", () => {
    devices.pair();
    for (const code of ["", "a".repeat(26), "nope"]) expect(devices.exchange(code, "x")).toBeNull();
  });

  it("keeps only hashes of codes and tokens", () => {
    const { code } = devices.pair();
    const paired = devices.exchange(code, "x");
    const dump = JSON.stringify([
      store.db.prepare("SELECT * FROM pairings").all(),
      store.db.prepare("SELECT * FROM devices").all(),
    ]);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(paired?.token);
    expect(dump).toContain(hashToken(code));
    expect(dump).toContain(hashToken(paired?.token ?? ""));
  });

  it("reads a code from a pasted link, its fragment, or by itself", () => {
    const code = "abcdefghijklmnopqrstuvwxyz";
    expect(pairingUrl("https://mac.ts.net:8443/", code)).toBe(`https://mac.ts.net:8443/pair#${code}`);
    expect(pairingCode(pairingUrl("https://mac.ts.net", code))).toBe(code);
    expect(pairingCode(` #${code.toUpperCase()} `)).toBe(code);
    expect(pairingCode("abcde-fghij klmno-pqrst-uvwxyz")).toBe(code);
    expect(pairingCode("https://mac.ts.net/pair")).toBeNull();
    expect(pairingCode("short")).toBeNull();
  });
});

describe("devices", () => {
  it("authenticates a token until its device is revoked", () => {
    const { code } = devices.pair();
    const paired = devices.exchange(code, "x");
    if (!paired) throw new Error("no pairing");
    expect(devices.authenticate("not-a-token")).toBeNull();
    expect(devices.authenticate(null)).toBeNull();
    devices.revoke(paired.device.id);
    expect(devices.authenticate(paired.token)).toBeNull();
    expect(devices.list()).toEqual([]);
    expect(() => devices.revoke(paired.device.id)).toThrow(/No paired device/);
  });

  it("closes a revoked device's connections, and only its own", () => {
    const a = devices.exchange(devices.pair().code, "a");
    const b = devices.exchange(devices.pair().code, "b");
    if (!a || !b) throw new Error("no pairing");
    const closed: string[] = [];
    devices.track(a.device.id, () => closed.push("a1"));
    const untrack = devices.track(a.device.id, () => closed.push("a2"));
    devices.track(b.device.id, () => closed.push("b1"));
    untrack();
    devices.revoke(a.device.id);
    expect(closed).toEqual(["a1"]);
  });

  it("renames", () => {
    const paired = devices.exchange(devices.pair().code, "iPhone");
    if (!paired) throw new Error("no pairing");
    expect(devices.rename(paired.device.id, "Work phone").name).toBe("Work phone");
    expect(devices.list()[0]?.name).toBe("Work phone");
    expect(() => devices.rename("dev_nopenopenopenopenope", "x")).toThrow(/No paired device/);
  });

  it("notes when a device was last seen, now and then rather than on every request", () => {
    const paired = devices.exchange(devices.pair().code, "x");
    if (!paired) throw new Error("no pairing");
    now += 5 * 60_000;
    expect(devices.authenticate(paired.token)?.lastSeenAt).toBe(new Date(now).toISOString());
    const seen = new Date(now).toISOString();
    now += 30_000;
    devices.authenticate(paired.token);
    expect(devices.list()[0]?.lastSeenAt).toBe(seen);
  });

  it("gives live passes that work until the device is revoked, with a key that lasts", () => {
    const paired = devices.exchange(devices.pair().code, "x");
    if (!paired) throw new Error("no pairing");
    const pass = devices.livePass(paired.device.id);
    const grant = devices.liveGrant(paired.device.id);
    expect(devices.checkLivePass(pass)?.id).toBe(paired.device.id);
    expect(devices.checkLivePass(grant)?.id).toBe(paired.device.id);
    // Another Devices on the same store (a restarted daemon) takes them too.
    expect(new Devices(store, { now: () => now }).checkLivePass(pass)?.id).toBe(paired.device.id);
    // A main token is not a live pass.
    expect(devices.checkLivePass(paired.token)).toBeNull();
    now += 25 * 60 * 60_000;
    expect(devices.checkLivePass(grant)).toBeNull(); // a grant lasts a day
    expect(devices.checkLivePass(pass)?.id).toBe(paired.device.id);
    devices.revoke(paired.device.id);
    expect(devices.checkLivePass(pass)).toBeNull();
  });
});

describe("where tenzo pair's link points", () => {
  it("--url, else TENZO_PUBLIC_URL, else https on the first allowed host", () => {
    const ts = "my-mac.tail0000.ts.net";
    expect(pairingOrigin({ allowedHosts: [ts] })).toBe(`https://${ts}`);
    expect(pairingOrigin({ allowedHosts: [ts], publicUrl: `https://${ts}:8443` })).toBe(`https://${ts}:8443`);
    expect(pairingOrigin({ allowedHosts: [ts] }, `https://${ts}:8443/whatever`)).toBe(`https://${ts}:8443`);
    expect(() => pairingOrigin({ allowedHosts: [] })).toThrow(/TENZO_ALLOWED_HOSTS/);
    expect(() => pairingOrigin({ allowedHosts: [ts] }, "my-mac")).toThrow(/--url/);
  });
});

describe("names", () => {
  it("guesses a device's kind from its User-Agent", () => {
    expect(
      nameFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15"),
    ).toBe("iPhone");
    expect(nameFromUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36")).toBe(
      "Android phone",
    );
    expect(nameFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Mac");
    expect(nameFromUserAgent(undefined)).toBe("Device");
  });
});
