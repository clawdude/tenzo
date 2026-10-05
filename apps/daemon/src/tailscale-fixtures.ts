/** Tailscale CLI output for tests (tailscale.test.ts, tailscale-setup.test.ts). Names and keys changed. */

export const NAME = "my-mac.tail1234.ts.net";

/** `tailscale status --json` from 1.102 (trimmed, names changed): signed in, MagicDNS, HTTPS on. */
export const STATUS_1_102 = {
  Version: "1.102.4-t3caf7d9e7-g084ee3b64",
  TUN: true,
  BackendState: "Running",
  TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
  Self: {
    ID: "nAbC",
    HostName: "My Mac",
    DNSName: "My-Mac.tail1234.ts.net.",
    OS: "macOS",
    TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::1"],
    Online: true,
    Capabilities: ["funnel", "https", "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000"],
    CapMap: { funnel: null, https: null },
  },
  Health: [],
  MagicDNSSuffix: "tail1234.ts.net",
  CurrentTailnet: { Name: "me@example.com", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
  CertDomains: [NAME],
  Peer: {},
};

/** An older shape (1.5x): no CurrentTailnet, no CertDomains, HTTPS only in Capabilities. */
export const STATUS_OLD = {
  Version: "1.56.1",
  BackendState: "Running",
  Self: { DNSName: `${NAME}.`, Capabilities: ["https"] },
  MagicDNSSuffix: "tail1234.ts.net",
};

/** `tailscale serve status --json` on the machine this was built on: one unrelated route on 443, and Tenzo's two. */
export const SERVE_SET_UP = {
  TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true }, "8444": { HTTPS: true } },
  Web: {
    [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } } },
    [`${NAME}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4780" } } },
    [`${NAME}:8444`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4781" } } },
  },
};

/** Before Tenzo: only the unrelated route. */
export const SERVE_UNRELATED = {
  TCP: { "443": { HTTPS: true } },
  Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } } } },
};
