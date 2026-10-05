# Remote access: your phone, over Tailscale

Tenzo runs on your Mac and listens on loopback only. To answer its cards from your phone, put [Tailscale Serve](https://tailscale.com/kb/1312/serve) in front of it and pair the phone once. This page is the whole setup; the security model behind it is in the README ([Remote access](../README.md#remote-access-pairing-devices)).

## Local and remote

- **Local** is the Mac itself: a request from loopback, to a loopback name (`127.0.0.1`, `localhost`, `::1`), with no proxy's forwarding header. No login: whoever sits at the Mac already has your agents.
- **Remote** is everything else, Tailscale Serve included: Serve connects from 127.0.0.1 but passes on the name the phone used and adds `X-Forwarded-For`. A remote browser needs a **paired device** token for the API, `/ws`, attachments and threads' live apps. Unpaired, it gets a "Pair this device" page.

## Why Tailscale Serve

- **HTTPS with a real certificate**, on your machine's tailnet name (`my-mac.tail1234.ts.net`). Tenzo's device cookie is `Secure`, so it only works over HTTPS; so do service workers (and with them Web Push).
- **Tailnet-only.** Only your own devices, signed in to your tailnet, can reach the name at all. Pairing is a second lock on top: a device on the tailnet still needs a one-time link from the Mac.
- **No cloud of ours, no open port.** Tailscale is the pipe, not the identity: Tenzo keeps its own device tokens and you revoke them in Tenzo.

Don't use Funnel (that opens it to the whole internet), and never raw TCP (see [below](#never-raw-tcp)).

## Setup

You need: Tailscale on the Mac and the phone, both signed in to the same tailnet, with MagicDNS on (the default). Tailscale 1.52 or later.

```bash
pnpm build                    # the web app the daemon serves
pnpm tenzo service install    # optional: keep the daemon running at login (macOS)
pnpm tenzo pair --tailscale --name "My iPhone"
```

`tenzo pair --tailscale` does the rest, asking before it changes anything:

1. **Finds this Mac's tailnet name** (`tailscale status --json`) and what Serve already serves (`tailscale serve status --json`).
2. **Plans two HTTPS routes**: `https://<name>:8443` → the daemon (`127.0.0.1:4780`, the Pass) and `https://<name>:8444` → its live listener (`127.0.0.1:4781`, threads' live apps). It shows the plan and the exact `tailscale serve` commands, and runs them when you say yes. A route that is already right is kept as it is (on whatever port it has). A port that serves something else is left alone: the route moves to the next free port instead. **Other routes are never changed or removed**, and Tenzo never uses `--tcp` or `--tls-terminated-tcp`.
3. **Makes the daemon match**: its `TENZO_ALLOWED_HOSTS` must name the tailnet host, `TENZO_LIVE_ORIGIN` the live route, `TENZO_PUBLIC_URL` the Pass's route. If the daemon runs as `tenzo service`, it shows what changes in the service's plist, and after you say yes updates it (nothing else in it) and restarts the service. Otherwise it prints the exact command to restart `tenzo serve` with, and you run `tenzo pair --tailscale` again afterwards.
4. **Prints the pairing link and QR code** for the tailnet URL.

Run it again any time: once everything is set up it changes nothing and just prints a fresh pairing link (plain `tenzo pair` does the same).

Options: `--yes` goes ahead without asking (for scripts; without a terminal to ask on, it stops instead), `--https-port <port>` and `--live-https-port <port>` pick the tailnet ports (a port that serves something else is an error then), `--name <name>` names the device.

The first time a tailnet uses Serve, `tailscale serve` may print a link to turn on HTTPS certificates for the tailnet: open it, approve, and it goes on. The phone's first load can take a few seconds while Tailscale gets the certificate.

### By hand

The same thing without `--tailscale`:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:4780   # the Pass
tailscale serve --bg --https=8444 http://127.0.0.1:4781   # threads' live apps

TENZO_ALLOWED_HOSTS=my-mac.tail1234.ts.net \
TENZO_LIVE_ORIGIN=https://my-mac.tail1234.ts.net:8444 \
TENZO_PUBLIC_URL=https://my-mac.tail1234.ts.net:8443 \
  pnpm tenzo serve        # or: … pnpm tenzo service install

pnpm tenzo pair --name "My iPhone"
```

`tailscale serve status` lists the routes; `tailscale serve --https=8443 off` removes one.

### Two routes, two origins

Threads' live apps (`expose`) are pages an agent's dev server serves: whatever their dependencies, embeds and bugs put in them. On Tenzo's own origin such a page could call the API with your cookie, answer your permission cards and start threads. So they get an origin of their own, a second listener on `TENZO_LIVE_PORT` (default the daemon's port + 1) behind a second Serve route. The daemon refuses that origin's requests, and the live listener has its own credential (a pass the daemon signs for your device), never Tenzo's cookie. Without the second route everything works except Open live from the phone.

### Settings

| Variable | Example | |
|---|---|---|
| `TENZO_ALLOWED_HOSTS` | `my-mac.tail1234.ts.net` | host names besides loopback the daemon answers to, comma-separated. Without the tailnet name, every request through Serve is refused (403) |
| `TENZO_LIVE_ORIGIN` | `https://my-mac.tail1234.ts.net:8444` | the live route, comma-separated if there are several; Open live links go to the one on the name you reached Tenzo by |
| `TENZO_PUBLIC_URL` | `https://my-mac.tail1234.ts.net:8443` | where devices reach the Pass, port included: the host of `tenzo pair`'s links |
| `TENZO_PORT`, `TENZO_LIVE_PORT` | `4780`, `4781` | the loopback ports the two routes point at |

The daemon reads them when it starts: change them, then restart it (`tenzo service install` again for the service, which bakes the shell's environment into its plist).

## Pairing a phone

`tenzo pair` prints a one-time link and its QR code. It works once, within 10 minutes; the browser that opens it gets its own long-lived token (a cookie) and lands on the Pass.

- **Safari:** scan the QR code with the camera and open the link.
- **The home-screen app** (Safari → Share → Add to Home Screen) keeps cookies of its own, apart from Safari's, so pairing Safari doesn't pair the app, and the camera always opens links in Safari. Open the app instead (it shows "Pair this device"), copy the link on the Mac and paste it into the app's **Or paste its link** field (Universal Clipboard carries it over). Each one is its own device in `tenzo devices`.

Open live works from the app too: its links carry their own pass into Safari.

## Revoking

```bash
tenzo devices                    # id, name, when paired, last seen
tenzo devices revoke <id>        # its token stops working; its open connections close at once
tenzo devices rename <id> <name…>
```

The app shows the same list under Threads → the phone icon, with Rename and Revoke. A revoked device needs a new `tenzo pair` to come back. New devices are paired from the Mac only.

Removing the Serve routes (`tailscale serve --https=8443 off`, and 8444) cuts every remote device off at once, paired or not; the Mac keeps working.

## Never raw TCP

> **Never forward raw TCP to Tenzo**: not `tailscale serve --tcp` or `--tls-terminated-tcp`, not `socat`, `ssh -R` or an ngrok TCP tunnel. They add no forwarding headers and let the client send `Host: localhost`, so **every client through them is local, with no pairing at all**. Use `tailscale serve --https` (an HTTP proxy) only. The same goes for any HTTP proxy that rewrites Host to loopback and drops the forwarding headers.

`tenzo pair --tailscale` refuses to run while a raw TCP route points at Tenzo's ports, and never makes one.

## Troubleshooting

**`Host "my-mac.tail1234.ts.net" is not allowed` (403).** The daemon doesn't know its tailnet name: add it to `TENZO_ALLOWED_HOSTS` and restart it, or run `tenzo pair --tailscale`, which does.

**"Paired, but this browser didn't keep Tenzo's cookie."** The cookie is `Secure`: it needs HTTPS. Open Tenzo by its Serve address (`https://<name>:8443`), not `http://`, an IP address, or a raw TCP forward.

**"This pairing link has expired or was already used."** Links work once, for 10 minutes. Run `tenzo pair` again.

**`tenzo pair`: "The daemon doesn't know where devices reach it."** Set `TENZO_PUBLIC_URL` (or run `tenzo pair --tailscale`), or pass `--url https://<name>:8443` once.

**Port in use.** The daemon says `127.0.0.1:4780 is already in use`: another `tenzo serve` (or the service) is running, or something else holds the port; stop it or set `TENZO_PORT` (and re-run `tenzo pair --tailscale` so the routes follow). For the tailnet side, `tenzo pair --tailscale` moves to the next free HTTPS port by itself, or takes `--https-port`.

**The page doesn't load on the phone.** Is the phone's Tailscale on and in the same tailnet? `tailscale serve status` on the Mac should list both routes, and `https://<name>:8443/health` should answer from any device on the tailnet.

**Open live doesn't open.** `TENZO_LIVE_ORIGIN` must name the live route exactly (`https://<name>:8444`), and that route must point at `TENZO_LIVE_PORT`.

**`tenzo pair --tailscale` says Tailscale isn't connected, or has no MagicDNS name.** Run `tailscale up` (or sign in from the menu bar), and turn MagicDNS on in the admin console's DNS page.

**A hand-started `tenzo serve` and the service.** Both want the same `TENZO_HOME`; the one that got there first keeps it, and the service retries every 10 s. Stop the hand-started one to let the service take over.
