import { describe, expect, it } from "vitest";
import { fetchSession, pairBrowser } from "./session.ts";

const device = { id: "dev_aaaaaaaaaaaaaaaaaaaa", name: "iPhone", createdAt: "t", lastSeenAt: null };

function answering(status: number, body: unknown, seen: RequestInit[] = []): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    seen.push(init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe("session", () => {
  it("says who the daemon takes this browser for", async () => {
    expect(await fetchSession("", answering(200, { mode: "remote", device: null }))).toEqual({
      mode: "remote",
      device: null,
    });
    expect(await fetchSession("", answering(200, { mode: "local", device: null }))).toMatchObject({ mode: "local" });
  });

  it("is null when the daemon can't say", async () => {
    expect(await fetchSession("", answering(503, "down"))).toBeNull();
    expect(await fetchSession("", answering(200, "<html>"))).toBeNull();
    const failing = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await fetchSession("", failing)).toBeNull();
  });
});

describe("pairing", () => {
  it("posts the code as JSON and gives back the device", async () => {
    const seen: RequestInit[] = [];
    const result = await pairBrowser("abc", { fetchFn: answering(200, { ok: true, device }, seen) });
    expect(result).toEqual({ ok: true, device });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toBe('{"code":"abc"}');
  });

  it("passes on the daemon's reason, or says it couldn't reach it", async () => {
    expect(await pairBrowser("abc", { fetchFn: answering(400, { ok: false, error: "expired" }) })).toEqual({
      ok: false,
      error: "expired",
    });
    expect(await pairBrowser("abc", { fetchFn: answering(502, "Bad gateway") })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/502/),
    });
  });
});
