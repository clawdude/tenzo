import { PairResponse, Session } from "@tenzo/contracts";

/**
 * Who the daemon takes this browser for (`GET /api/session`): on the Mac, a paired device, or
 * an unpaired one from elsewhere, which gets nothing else until it pairs. Null when the daemon
 * can't be asked (down, or an answer that isn't one): the connection's own retries take over.
 */
export async function fetchSession(base = "", fetchFn: typeof fetch = fetch): Promise<Session | null> {
  try {
    const response = await fetchFn(`${base}/api/session`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) return null;
    const parsed = Session.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Pairs this browser with a pairing link's code (`POST /api/pair`): the daemon answers with this
 * device and sets its token as a cookie, which no script here can read.
 */
export async function pairBrowser(
  code: string,
  { name, base = "", fetchFn = fetch }: { name?: string; base?: string; fetchFn?: typeof fetch } = {},
): Promise<PairResponse> {
  let response: Response;
  try {
    response = await fetchFn(`${base}/api/pair`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(name ? { code, name } : { code }),
    });
  } catch {
    return { ok: false, error: "Can't reach Tenzo. Is the daemon running, and this device on the tailnet?" };
  }
  try {
    const parsed = PairResponse.safeParse(await response.json());
    if (parsed.success) return parsed.data;
  } catch {
    // said below
  }
  return { ok: false, error: `Tenzo answered ${response.status}; pairing didn't happen.` };
}
