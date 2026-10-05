import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { PushMessage, QueueItem, ThreadView } from "@tenzo/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { WebSocket } from "ws";
import { FakeAdapter } from "./agent/fake-agent.ts";
import { executeCommand } from "./commands.ts";
import { Devices } from "./devices.ts";
import type { EngineChange } from "./engine.ts";
import { TenzoError } from "./errors.ts";
import {
  loadVapidKeys,
  Push,
  type PushRequest,
  type PushResponse,
  pushEndpointAllowed,
  pushMessageOf,
  pushRequest,
  retryAfterMs,
  subscriptionProblem,
  TEST_EVERY_MS,
  VISIBLE_FRESH_MS,
  type VapidKeys,
  vapidKeysPath,
} from "./push.ts";
import { addProject } from "./projects.ts";
import { type RunningDaemon, startDaemon } from "./server.ts";
import { openStore, type Store } from "./store.ts";
import { initRepo, pairDevice, removeTempDirs, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

// A browser's side of Web Push, to check what the daemon sends: its keys, and RFC 8291's
// decryption.

interface Browser {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  /** Decrypts an aes128gcm body sent to this browser. */
  open(body: Uint8Array): string;
}

function browser(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(6).toString("hex")}`): Browser {
  const ecdh = createECDH("prime256v1");
  const uaPublic = ecdh.generateKeys();
  const auth = randomBytes(16);
  const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
  return {
    subscription: {
      endpoint,
      keys: { p256dh: uaPublic.toString("base64url"), auth: auth.toString("base64url") },
    },
    open(body) {
      const bytes = Buffer.from(body);
      const salt = bytes.subarray(0, 16);
      const idLength = bytes[20] ?? 0;
      const asPublic = bytes.subarray(21, 21 + idLength);
      const sealed = bytes.subarray(21 + idLength);
      const secret = ecdh.computeSecret(asPublic);
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
      const ikm = hmac(hmac(auth, secret), Buffer.concat([info, Buffer.from([1])]));
      const prk = hmac(salt, ikm);
      const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
      const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
      const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
      // The last record ends with 0x02, then padding zeros.
      let end = plain.length;
      while (end > 0 && plain[end - 1] === 0) end--;
      return plain.subarray(0, end - 1).toString("utf8");
    },
  };
}

/** The VAPID JWT's claims, after checking its ES256 signature against `publicKey`. */
function vapidClaims(authorization: string, publicKey: string): Record<string, unknown> {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
  if (!match?.[1] || !match[2]) throw new Error(`not a VAPID header: ${authorization}`);
  expect(match[2]).toBe(publicKey);
  const [header, claims, signature] = match[1].split(".") as [string, string, string];
  const raw = Buffer.from(publicKey, "base64url");
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  const ok = verify(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
  expect(ok).toBe(true);
  return JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
}

let seq = 0;
function item(over: Partial<QueueItem> = {}): QueueItem {
  seq++;
  return {
    id: `itm_${String(seq).padStart(20, "0")}`,
    environmentId: "env_test0000000000000000",
    threadId: "thr_aaaaaaaaaaaaaaaaaaaa",
    lane: "quick",
    kind: "question",
    requestId: `req_${seq}`,
    context: "I read the auth module and the secret token sk-live-123.",
    ask: "Which auth method should I use?",
    options: [],
    suggested: null,
    questions: [],
    createdAt: new Date(Date.UTC(2026, 9, 5, 10, 0, seq)).toISOString(),
    status: "open",
    detached: false,
    resolvedAt: null,
    resolution: null,
    snoozedUntil: null,
    ...over,
  } as QueueItem;
}

describe("VAPID keys", () => {
  it("are made once, kept readable only by you, and the same after a restart", () => {
    const home = tempDir("home");
    const keys = loadVapidKeys(home);
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(vapidKeysPath(home)).mode & 0o777).toBe(0o600);
    expect(loadVapidKeys(home)).toEqual(keys);
  });

  it("tightens a file someone loosened", () => {
    const home = tempDir("home");
    const keys = loadVapidKeys(home);
    chmodSync(vapidKeysPath(home), 0o644);
    expect(loadVapidKeys(home)).toEqual(keys);
    expect(statSync(vapidKeysPath(home)).mode & 0o777).toBe(0o600);
  });

  it("never replaces a broken file silently: every subscription hangs on it", () => {
    const home = tempDir("home");
    writeFileSync(vapidKeysPath(home), "{nope", { mode: 0o600 });
    expect(() => loadVapidKeys(home)).toThrow(TenzoError);
    expect(() => loadVapidKeys(home)).toThrow(/Delete it/);
  });

  it("are only generated when there are none", () => {
    const home = tempDir("home");
    loadVapidKeys(home);
    const generate = vi.spyOn(webpush, "generateVAPIDKeys");
    loadVapidKeys(home);
    expect(generate).not.toHaveBeenCalled();
    generate.mockRestore();
  });
});

describe("what a push says", () => {
  it("is the thread's name and the ask, one notification per thread, opening the card", () => {
    const question = item();
    expect(pushMessageOf(question, "Fix login", "short")).toEqual({
      tag: question.threadId,
      title: "Fix login",
      body: "Which auth method should I use?",
      url: `/?item=${question.id}`,
    });
  });

  it("never carries context or a permission's input", () => {
    const permission = item({
      kind: "permission",
      ask: "Run curl -H 'Authorization: Bearer sk-live-123' https://api",
      permission: {
        toolKind: "command",
        toolName: "Bash",
        detail: "curl -H 'Authorization: Bearer sk-live-123' https://api",
        input: { command: "curl -H 'Authorization: Bearer sk-live-123' https://api" },
      },
    });
    const message = pushMessageOf(permission, "Deploy", "short");
    expect(message.body).toBe("Allow Bash?");
    expect(JSON.stringify(message)).not.toMatch(/sk-live|curl|auth module/);
  });

  it("is short: one line, cut", () => {
    const long = item({ ask: `A very\nlong question ${"word ".repeat(80)}` });
    const message = pushMessageOf(long, "T".repeat(200), "short");
    expect(message.title.length).toBeLessThanOrEqual(60);
    expect(message.body.length).toBeLessThanOrEqual(120);
    expect(message.body).not.toMatch(/\n/);
    expect(message.body.endsWith("…")).toBe(true);
  });

  it("says what kind of card it is", () => {
    expect(pushMessageOf(item({ kind: "proposal", ask: "Add OAuth" }), "t", "short").body).toBe(
      "Proposes: Add OAuth",
    );
    expect(pushMessageOf(item({ kind: "ready", ask: "PR #3" }), "t", "short").body).toBe(
      "Ready to merge: PR #3",
    );
    expect(pushMessageOf(item({ kind: "error", ask: "Budget reached" }), "t", "short").body).toBe(
      "Budget reached",
    );
  });

  it("says nothing at all with preview none", () => {
    const message = pushMessageOf(item(), "Fix login", "none");
    expect(message).toMatchObject({ title: "Tenzo", body: "A thread needs you." });
    expect(JSON.stringify(message)).not.toMatch(/login|auth/i);
  });
});

describe("a push request", () => {
  it("is encrypted to the browser, signed for its push service, one topic per thread", () => {
    const keys = loadVapidKeys(tempDir("home"));
    const phone = browser("https://web.push.apple.com/QGlk-some-token");
    const message: PushMessage = { tag: "thr_aaaaaaaaaaaaaaaaaaaa", title: "t", body: "b", url: "/" };
    const request = pushRequest(phone.subscription, message, {
      keys,
      contact: "mailto:me@example.com",
      topic: message.tag,
    });
    expect(request.endpoint).toBe(phone.subscription.endpoint);
    expect(JSON.parse(phone.open(request.body))).toEqual(message);
    // Nothing readable on the wire.
    expect(Buffer.from(request.body).toString("latin1")).not.toContain("thr_");
    expect(request.headers).toMatchObject({
      "Content-Encoding": "aes128gcm",
      Urgency: "high",
      Topic: "thr_aaaaaaaaaaaaaaaaaaaa",
      TTL: "3600",
    });
    const claims = vapidClaims(request.headers.Authorization ?? "", keys.publicKey);
    expect(claims.aud).toBe("https://web.push.apple.com");
    expect(claims.sub).toBe("mailto:me@example.com");
    // At most 24 h ahead, as Apple insists.
    expect(Number(claims.exp) * 1000 - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);
  });

  it("leaves out a topic that isn't one", () => {
    const keys = loadVapidKeys(tempDir("home"));
    const request = pushRequest(browser().subscription, { tag: "x", title: "", body: "", url: "/" }, {
      keys,
      contact: "mailto:me@example.com",
      topic: "not a topic!",
    });
    expect(request.headers.Topic).toBeUndefined();
  });
});

describe("which endpoints are push services", () => {
  it("are Apple's, Google's, Mozilla's and Microsoft's", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://jmt17.google.com/fcm/send/abc",
      "https://web.push.apple.com/QGlk",
      "https://api.push.apple.com/3/device/x",
      "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://wns2-par02p.notify.windows.com/w/?token=x",
      "https://FCM.GoogleAPIs.com./fcm/send/x",
      "https://fcm.googleapis.com:443/fcm/send/x",
    ]) {
      expect(pushEndpointAllowed(ok), ok).toBe(true);
    }
  });

  it("are nothing the daemon could be made to call on a page's behalf", () => {
    for (const bad of [
      // Loopback, in every spelling the URL parser understands.
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://127.1/x",
      "https://0x7f000001/x",
      "https://2130706433/x",
      "https://[::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://pair.localhost/x",
      // The LAN, cloud metadata, the tailnet.
      "https://10.0.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://100.100.100.100/x",
      "https://my-mac.tail0000.ts.net:8443/api/commands",
      // A push service's name, but not on its default port, not https, or with credentials.
      "https://fcm.googleapis.com:8443/x",
      "http://fcm.googleapis.com/x",
      "https://user:pw@fcm.googleapis.com/x",
      // Look-alikes, and what a parser might read two ways.
      "https://googleapis.com/x",
      "https://evilgoogleapis.com/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evil.example/?fcm.googleapis.com",
      "https://fcm.googleapis.com\\@evil.example/x",
      "https://fcm.googleapis.com\t/x",
      "https://fcm.goog\nleapis.com/x",
      "not a url",
    ]) {
      expect(pushEndpointAllowed(bad), bad).toBe(false);
    }
  });

  it("are checked when a device subscribes, keys too", () => {
    const store = openStore(join(tempDir("home"), ".tenzo"));
    const devices = new Devices(store);
    const phone = pairDevice(devices);
    const { subscription } = browser();
    const at = (endpoint: string) => ({ ...subscription, endpoint });
    expect(() => devices.subscribe(phone.id, at("https://169.254.169.254/x"))).toThrow(
      /known push service/,
    );
    expect(() => devices.subscribe(phone.id, at("https://127.1/x"))).toThrow(/known push service/);
    const keys = subscription.keys;
    const offCurve = Buffer.from(keys.p256dh, "base64url");
    offCurve[64] = (offCurve[64] ?? 0) ^ 1;
    for (const bad of [
      { ...keys, p256dh: offCurve.toString("base64url") },
      { ...keys, p256dh: Buffer.alloc(65, 4).toString("base64url") },
      { ...keys, p256dh: Buffer.alloc(64, 1).toString("base64url") },
      { ...keys, auth: Buffer.alloc(15).toString("base64url") },
    ]) {
      expect(() => devices.subscribe(phone.id, { ...subscription, keys: bad })).toThrow(
        /aren't Web Push keys/,
      );
    }
    expect(devices.pushTargets()).toEqual([]);
    expect(subscriptionProblem(subscription)).toBeNull();
    store.close();
  });
});

describe("Retry-After", () => {
  it("takes seconds or a date, capped, and ignores garbage", () => {
    const now = Date.parse("2026-10-05T10:00:00Z");
    expect(retryAfterMs("30", now)).toBe(30_000);
    expect(retryAfterMs("Mon, 05 Oct 2026 10:01:00 GMT", now)).toBe(60_000);
    expect(retryAfterMs("86400", now)).toBe(600_000);
    expect(retryAfterMs("soon", now)).toBe(0);
    expect(retryAfterMs(null, now)).toBe(0);
  });
});

describe("subscriptions", () => {
  let store: Store;
  let devices: Devices;
  beforeEach(() => {
    store = openStore(join(tempDir("home"), ".tenzo"));
    devices = new Devices(store);
  });
  afterEach(() => store.close());

  it("are kept per device and show on its record", () => {
    const phone = pairDevice(devices, "Phone");
    expect(devices.find(phone.id)?.push).toEqual({ subscribed: false, muted: false });
    const { subscription } = browser();
    expect(devices.subscribe(phone.id, subscription).push).toEqual({ subscribed: true, muted: false });
    expect(devices.pushTargets()).toEqual([
      { deviceId: phone.id, name: "Phone", muted: false, subscription },
    ]);
    // A new subscription replaces the old one.
    const again = browser();
    devices.subscribe(phone.id, again.subscription);
    expect(devices.pushTargets().map((t) => t.subscription.endpoint)).toEqual([
      again.subscription.endpoint,
    ]);
    expect(devices.unsubscribe(phone.id).push.subscribed).toBe(false);
    expect(devices.pushTargets()).toEqual([]);
  });

  it("are deleted when the device is revoked", () => {
    const phone = pairDevice(devices);
    devices.subscribe(phone.id, browser().subscription);
    devices.revoke(phone.id);
    expect(devices.pushTargets()).toEqual([]);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get()).toEqual({ n: 0 });
  });

  it("follow the browser: one that paired again keeps a single subscription", () => {
    const first = pairDevice(devices, "Safari");
    const second = pairDevice(devices, "Home screen");
    const { subscription } = browser();
    devices.subscribe(first.id, subscription);
    devices.subscribe(second.id, subscription);
    expect(devices.pushTargets().map((t) => t.deviceId)).toEqual([second.id]);
  });

  it("mute per device, subscribed or not", () => {
    const phone = pairDevice(devices);
    expect(devices.mute(phone.id, true).push.muted).toBe(true);
    devices.subscribe(phone.id, browser().subscription);
    expect(devices.pushTarget(phone.id)?.muted).toBe(true);
    expect(devices.mute(phone.id, false).push).toEqual({ subscribed: true, muted: false });
  });

  it("drop a gone subscription only if it is still the device's", () => {
    const phone = pairDevice(devices);
    const old = browser();
    devices.subscribe(phone.id, old.subscription);
    const fresh = browser();
    devices.subscribe(phone.id, fresh.subscription);
    expect(devices.dropSubscription(phone.id, old.subscription.endpoint)).toBe(false);
    expect(devices.pushTarget(phone.id)?.subscription.endpoint).toBe(fresh.subscription.endpoint);
    expect(devices.dropSubscription(phone.id, fresh.subscription.endpoint)).toBe(true);
    expect(devices.pushTarget(phone.id)).toBeNull();
  });
});

describe("Push", () => {
  let store: Store;
  let devices: Devices;
  let keys: VapidKeys;
  let push: Push;
  let sent: { request: PushRequest; device: string; message: PushMessage }[];
  let answer: (request: PushRequest) => PushResponse;
  let listener: (change: EngineChange) => void;
  let browsers: Map<string, Browser>;
  let logged: string[];

  const titles: Record<string, string> = { thr_aaaaaaaaaaaaaaaaaaaa: "Fix login" };

  /** A paired device whose browser subscribed. */
  function phone(name: string): { id: string; browser: Browser } {
    const paired = pairDevice(devices, name);
    const b = browser();
    devices.subscribe(paired.id, b.subscription);
    browsers.set(b.subscription.endpoint, b);
    return { id: paired.id, browser: b };
  }

  const opened = (it: QueueItem) => listener({ type: "item", change: { type: "opened", item: it } });
  const changed = (type: "resolved" | "snoozed" | "unsnoozed" | "updated", it: QueueItem) =>
    listener({ type: "item", change: { type, item: it } });

  beforeEach(() => {
    vi.useFakeTimers();
    store = openStore(join(tempDir("home"), ".tenzo"));
    devices = new Devices(store);
    keys = loadVapidKeys(store.home);
    sent = [];
    logged = [];
    browsers = new Map();
    answer = () => ({ status: 201, retryAfter: null });
    push = new Push({
      devices,
      keys,
      contact: "mailto:me@example.com",
      send: async (request) => {
        const b = browsers.get(request.endpoint);
        const target = devices.pushTargets().find((t) => t.subscription.endpoint === request.endpoint);
        sent.push({
          request,
          device: target?.deviceId ?? "?",
          message: JSON.parse(b?.open(request.body) ?? "null"),
        });
        return answer(request);
      },
      log: (message) => logged.push(message),
    });
    push.start({
      subscribe: (l) => {
        listener = l;
        return () => {};
      },
      view: (id) => ({ title: titles[id] ?? "" }),
    });
  });
  afterEach(() => {
    push.close();
    store.close();
    vi.useRealTimers();
  });

  it("pushes a quick-lane card to every subscribed device, once, after the burst", async () => {
    const a = phone("Phone");
    const b = phone("iPad");
    const question = item();
    opened(question);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent.map((s) => s.device).sort()).toEqual([a.id, b.id].sort());
    expect(sent[0]?.message).toEqual({
      tag: question.threadId,
      title: "Fix login",
      body: "Which auth method should I use?",
      url: `/?item=${question.id}`,
    });
    // An update of the same card (a detach, say) doesn't push again.
    changed("updated", { ...question, detached: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(2);
  });

  it("never pushes finished work (the review lane)", async () => {
    phone("Phone");
    opened(item({ lane: "review", kind: "finished", ask: "Done" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([]);
  });

  it("never pushes a card answered before the push went", async () => {
    phone("Phone");
    const question = item();
    opened(question);
    await vi.advanceTimersByTimeAsync(1_000);
    changed("resolved", { ...question, status: "resolved" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([]);
  });

  it("collapses a burst on one thread into one push, for its newest card", async () => {
    phone("Phone");
    const first = item({ ask: "First?" });
    const second = item({ ask: "Second?" });
    opened(first);
    await vi.advanceTimersByTimeAsync(1_000);
    opened(second);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent.map((s) => s.message.body)).toEqual(["Second?"]);
    expect(sent[0]?.request.headers.Topic).toBe(first.threadId);
    // A later card on the same thread pushes again, under the same tag (replacing it).
    const third = item({ ask: "Third?" });
    opened(third);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent.map((s) => [s.message.tag, s.message.body])).toEqual([
      [first.threadId, "Second?"],
      [first.threadId, "Third?"],
    ]);
  });

  it("pushes each thread on its own", async () => {
    phone("Phone");
    opened(item());
    opened(item({ threadId: "thr_bbbbbbbbbbbbbbbbbbbb" }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent.map((s) => s.message.tag).sort()).toEqual([
      "thr_aaaaaaaaaaaaaaaaaaaa",
      "thr_bbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  it("skips a muted device; the others still get it", async () => {
    const muted = phone("Phone");
    const other = phone("iPad");
    devices.mute(muted.id, true);
    opened(item());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent.map((s) => s.device)).toEqual([other.id]);
  });

  it("skips a device looking at Tenzo, until its page hides or goes quiet", async () => {
    const looking = phone("Phone");
    const presence = push.presence(looking.id);
    presence.visible(true);
    expect(push.inView(looking.id)).toBe(true);
    opened(item({ ask: "One?" }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toEqual([]);

    presence.visible(false);
    opened(item({ threadId: "thr_bbbbbbbbbbbbbbbbbbbb", ask: "Two?" }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent.map((s) => s.message.body)).toEqual(["Two?"]);

    // In view, but its socket stopped talking (a frozen page): counts as away.
    presence.visible(true);
    await vi.advanceTimersByTimeAsync(VISIBLE_FRESH_MS);
    expect(push.inView(looking.id)).toBe(false);
    opened(item({ threadId: "thr_cccccccccccccccccccc", ask: "Three?" }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent.map((s) => s.message.body)).toEqual(["Two?", "Three?"]);

    // A closed socket says nothing any more.
    presence.visible(true);
    presence.close();
    expect(push.inView(looking.id)).toBe(false);
  });

  it("pushes a snoozed card again when it comes back", async () => {
    phone("Phone");
    const question = item();
    opened(question);
    await vi.advanceTimersByTimeAsync(3_000);
    changed("snoozed", { ...question, snoozedUntil: "2026-10-05T10:15:00.000Z" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toHaveLength(1);
    changed("unsnoozed", question);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toHaveLength(2);
  });

  it("drops what an archived thread had pending", async () => {
    phone("Phone");
    opened(item());
    listener({
      type: "thread",
      thread: { id: "thr_aaaaaaaaaaaaaaaaaaaa", status: "archived" } as ThreadView,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([]);
  });

  it("forgets a subscription its push service says is gone", async () => {
    const gone = phone("Phone");
    answer = () => ({ status: 410, retryAfter: null });
    opened(item());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toHaveLength(1);
    expect(devices.find(gone.id)?.push.subscribed).toBe(false);
  });

  it("retries a failing push service with backoff, while the card is still open", async () => {
    phone("Phone");
    const statuses = [503, 0, 201];
    answer = () => ({ status: statuses.shift() ?? 201, retryAfter: null });
    opened(item());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sent).toHaveLength(3);
  });

  it("honours Retry-After, and gives up on a card answered meanwhile", async () => {
    phone("Phone");
    answer = () => ({ status: 429, retryAfter: "60" });
    const question = item();
    opened(question);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(1);
    changed("resolved", { ...question, status: "resolved" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toHaveLength(1);
  });

  it("doesn't retry what the push service refuses for good", async () => {
    phone("Phone");
    answer = () => ({ status: 403, retryAfter: null });
    opened(item());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toHaveLength(1);
    expect(logged.join("\n")).toMatch(/403/);
  });

  it("never throws into the engine, whatever the sender does", async () => {
    phone("Phone");
    answer = () => {
      throw new Error("boom");
    };
    expect(() => opened(item())).not.toThrow();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(logged.join("\n")).toMatch(/boom/);
  });

  it("sends a test notification on request, muted or not, at most one per 10 s", async () => {
    const p = phone("Phone");
    devices.mute(p.id, true);
    await expect(push.test(p.id)).resolves.toEqual({ sent: true, error: null });
    expect(sent[0]?.message).toMatchObject({ tag: "tenzo-test", title: "Tenzo", url: "/devices" });
    expect((await push.test(p.id)).error).toMatch(/a moment ago/);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TEST_EVERY_MS);
    answer = () => ({ status: 404, retryAfter: null });
    expect((await push.test(p.id)).error).toMatch(/Turn notifications on again/);
    expect(devices.find(p.id)?.push.subscribed).toBe(false);
    expect((await push.test(p.id)).error).toMatch(/hasn't turned notifications on/);
  });

  it("says nothing of what the push service answered to a test", async () => {
    const p = phone("Phone");
    answer = () => ({ status: 502, retryAfter: null });
    const { sent: ok, error } = await push.test(p.id);
    expect(ok).toBe(false);
    expect(error).toBe("The push service didn't take it. Try again later.");
  });

  it("skips only the device that is looking", async () => {
    const looking = phone("Phone");
    const away = phone("iPad");
    push.presence(looking.id).visible(true);
    opened(item());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent.map((s) => s.device)).toEqual([away.id]);
  });

  it("never lets a retry of an older card replace a newer card's notification", async () => {
    phone("Phone");
    const statuses = [503];
    answer = () => ({ status: statuses.shift() ?? 201, retryAfter: null });
    opened(item({ ask: "Older?" }));
    await vi.advanceTimersByTimeAsync(3_000); // fails: a retry is due in 5 s
    opened(item({ ask: "Newer?" }));
    await vi.advanceTimersByTimeAsync(3_000); // the newer card's push goes
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sent.map((s) => s.message.body)).toEqual(["Older?", "Newer?"]);
  });

  it("never sends to a subscription no push service would take, and forgets it", async () => {
    const p = pairDevice(devices, "Phone");
    // As if stored before the check: straight into the table.
    store.db
      .prepare(
        "INSERT INTO push_subscriptions (device_id, environment_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(p.id, store.environmentId, "https://169.254.169.254/latest", browser().subscription.keys.p256dh, "x".repeat(22), "t");
    opened(item());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([]);
    expect(devices.find(p.id)?.push.subscribed).toBe(false);
    expect(logged.join("\n")).toMatch(/known push service/);
  });

  it("doesn't retry a push that can't be built", async () => {
    const p = pairDevice(devices, "Phone");
    const { subscription } = browser();
    devices.subscribe(p.id, subscription);
    // Keys that pass the subscribe check but that the encryption then refuses (a bad private key).
    push.close();
    const broken = new Push({
      devices,
      keys: { ...keys, privateKey: "AAAA" },
      send: async () => {
        sent.push({ request: {} as PushRequest, device: p.id, message: {} as PushMessage });
        return { status: 201, retryAfter: null };
      },
      log: (message) => logged.push(message),
    });
    broken.start({ subscribe: (l) => ((listener = l), () => {}), view: () => ({ title: "" }) });
    opened(item());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent).toEqual([]);
    expect(logged.join("\n")).toMatch(/couldn't be built/);
    broken.close();
  });

  describe("commands", () => {
    it("subscribe the paired device asking, never the Mac itself", async () => {
      const paired = pairDevice(devices, "Phone");
      const device = devices.find(paired.id);
      if (!device) throw new Error("no device");
      const { subscription } = browser();
      const local = await executeCommand(
        undefined,
        { type: "device.subscribe", subscription },
        { devices, push, caller: { mode: "local", device: null } },
      );
      expect(local).toMatchObject({ ok: false, error: expect.stringMatching(/paired devices/) });
      const remote = await executeCommand(
        undefined,
        { type: "device.subscribe", subscription },
        { devices, push, caller: { mode: "remote", device } },
      );
      expect(remote).toMatchObject({ ok: true, result: { device: { push: { subscribed: true } } } });
      const list = await executeCommand(
        undefined,
        { type: "device.list" },
        { devices, push, caller: { mode: "remote", device } },
      );
      expect(list).toMatchObject({ ok: true, result: { pushKey: keys.publicKey, current: paired.id } });
    });
  });
});

describe("end to end", () => {
  const TS = "my-mac.tail0000.ts.net";
  /** A request from the paired phone's page, through Tailscale Serve. */
  const fromPhone = (cookie: string) => ({
    host: `${TS}:8443`,
    origin: `https://${TS}:8443`,
    "sec-fetch-site": "same-origin",
    "x-forwarded-for": "100.64.0.7",
    cookie,
  });
  let daemon: RunningDaemon;
  let adapter: FakeAdapter;
  let pushed: { endpoint: string; body: Uint8Array }[];

  beforeEach(async () => {
    const home = join(tempDir("home"), ".tenzo");
    const store = openStore(home);
    await addProject(store, initRepo("app"));
    store.close();
    adapter = new FakeAdapter();
    pushed = [];
    daemon = await startDaemon(
      { host: "127.0.0.1", port: 0, home, webDir: join(home, "web"), allowedHosts: [TS], devOrigins: [] },
      {
        adapters: { claude: adapter },
        pushDebounceMs: 50,
        pushSend: async ({ endpoint, body }) => {
          pushed.push({ endpoint, body });
          return { status: 201, retryAfter: null };
        },
      },
    );
  });
  afterEach(() => daemon.close());

  interface Answer {
    ok: boolean;
    result?: { pushKey?: string };
    error?: string;
  }

  /** A command over HTTP, Host included (fetch won't set it). */
  function command(headers: Record<string, string>, body: unknown): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: daemon.port,
          path: "/api/commands",
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString()) as Answer));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  }

  /** A socket from the phone; resolves once its snapshot arrived. */
  function socket(headers: Record<string, string>): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`, { headers });
      ws.on("message", (data) => {
        if (JSON.parse(String(data)).type === "snapshot") resolve(ws);
      });
      ws.on("error", reject);
    });
  }

  it("a question reaches the phone's browser, not while it looks at the Pass, and revoking ends it", async () => {
    const phone = pairDevice(daemon.devices, "Phone");
    const b = browser();
    const headers = fromPhone(phone.cookie);
    const list = await command(headers, { type: "device.list" });
    expect(list.result?.pushKey).toBe(daemon.push.publicKey);
    const subscribed = await command(headers, { type: "device.subscribe", subscription: b.subscription });
    expect(subscribed.ok).toBe(true);

    const thread = await daemon.engine.createThread({ project: "app", title: "Fix login" });
    daemon.engine.send(thread.id, "go");
    await expect.poll(() => adapter.sessions.length).toBe(1);
    adapter.last.ask([
      { id: "q", header: "Auth", question: "Which auth method?", options: [], multiSelect: false },
    ]);
    await expect.poll(() => pushed.length).toBe(1);
    const message = JSON.parse(b.open(pushed[0]?.body ?? new Uint8Array())) as PushMessage;
    expect(message).toMatchObject({ tag: thread.id, title: "Fix login", body: "Which auth method?" });
    expect(message.url).toMatch(/^\/\?item=itm_/);

    // The Pass open and in view on the phone: it sees the card, no push.
    const ws = await socket(headers);
    ws.send(JSON.stringify({ type: "visibility", visible: true }));
    await expect.poll(() => daemon.push.inView(phone.id)).toBe(true);
    adapter.last.askPermission("Bash", { command: "ls" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pushed).toHaveLength(1);

    // Hidden again: the next card pushes.
    ws.send(JSON.stringify({ type: "visibility", visible: false }));
    await expect.poll(() => daemon.push.inView(phone.id)).toBe(false);
    adapter.last.propose("Add OAuth. Then tests.");
    await expect.poll(() => pushed.length).toBe(2);

    // Revoked: its subscription is gone, so nothing more reaches it.
    daemon.devices.revoke(phone.id);
    expect(daemon.devices.pushTargets()).toEqual([]);
    ws.close();
  });

  it("refuses subscriptions from the Mac itself", async () => {
    const local = await command(
      { host: `127.0.0.1:${daemon.port}` },
      { type: "device.subscribe", subscription: browser().subscription },
    );
    expect(local.ok).toBe(false);
    expect(local.error).toMatch(/paired devices/);
  });
});
