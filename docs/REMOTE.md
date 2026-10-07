# Remote access: your phone, over Tailscale

Tenzo runs on your Mac and listens on loopback only. To answer its cards from your phone, put [Tailscale Serve](https://tailscale.com/kb/1312/serve) in front of it and pair the phone once. The security model behind this is in [ARCHITECTURE.md](ARCHITECTURE.md) (D10, D12, D13).

## Local and remote

- **Local** is the Mac itself: a request from loopback, to a loopback name (`127.0.0.1`, `localhost`, `::1`), with no proxy's forwarding header. No login: whoever sits at the Mac already has your agents.
- **Remote** is everything else, Tailscale Serve included (it connects from 127.0.0.1 but passes on the name the phone used and adds `X-Forwarded-For`). A remote browser needs to be a **paired device** for the API, `/ws`, attachments and threads' live apps; unpaired, it gets a "Pair this device" page.

## Why Tailscale Serve

- **HTTPS with a real certificate** on your machine's tailnet name (`my-mac.tail1234.ts.net`). Tenzo's device cookie is `Secure`, so it needs HTTPS; so do service workers, and with them notifications.
- **Tailnet-only.** Only your own devices can reach the name. Pairing is a second lock: a device on the tailnet still needs a one-time link from the Mac.
- **No cloud of ours, no open port.** Tailscale is the pipe, not the identity: Tenzo keeps its own device tokens and you revoke them in Tenzo.

Don't use Funnel (that opens it to the whole internet), and never raw TCP ([below](#never-raw-tcp)).

## Setup

You need Tailscale 1.52 or later on the Mac and the phone, signed in to the same tailnet, with MagicDNS on (the default).

```bash
pnpm build                    # the web app the daemon serves
pnpm tenzo service install    # optional: keep the daemon running (macOS)
pnpm tenzo pair --tailscale --name "My iPhone"
```

`tenzo pair --tailscale` does the rest, asking before it changes anything:

1. **Finds this Mac's tailnet name** and what Serve already serves.
2. **Plans two HTTPS routes**: `https://<name>:8443` → the daemon (`127.0.0.1:4780`, the Pass) and `https://<name>:8444` → its live listener (`127.0.0.1:4781`, threads' live apps). It shows the exact `tailscale serve` commands and runs them when you say yes. A route that is already right is kept (on whatever port it has); a port that serves something else is left alone and the route moves to the next free port. **Other routes are never changed or removed**, and it never uses `--tcp` or `--tls-terminated-tcp`.
3. **Makes the daemon match**: `TENZO_ALLOWED_HOSTS` must name the tailnet host, `TENZO_LIVE_ORIGIN` the live route, `TENZO_PUBLIC_URL` the Pass's route. For `tenzo service`, it shows what changes in the service's plist, updates only that after you say yes, and restarts the service. Otherwise it prints the command to restart `tenzo serve` with; run `tenzo pair --tailscale` again afterwards.
4. **Prints the pairing link and QR code** for the tailnet URL.

Run it again any time: once everything is set up it changes nothing and prints a fresh pairing link, as plain `tenzo pair` does.

Options: `--yes` goes ahead without asking (without a terminal to ask on, it stops instead), `--https-port` and `--live-https-port` pick the tailnet ports (a port serving something else is then an error), `--name` names the device.

The first time a tailnet uses Serve, `tailscale serve` may print a link to turn on HTTPS certificates: open it and approve. The phone's first load can take a few seconds while Tailscale gets the certificate.

### By hand

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:4780   # the Pass
tailscale serve --bg --https=8444 http://127.0.0.1:4781   # threads' live apps

TENZO_ALLOWED_HOSTS=my-mac.tail1234.ts.net \
TENZO_LIVE_ORIGIN=https://my-mac.tail1234.ts.net:8444 \
TENZO_PUBLIC_URL=https://my-mac.tail1234.ts.net:8443 \
  pnpm tenzo serve        # or: … pnpm tenzo service install

pnpm tenzo pair --name "My iPhone"
```

`tailscale serve status` lists the routes; `tailscale serve --https=8443 off` removes one. The daemon reads its settings when it starts (the table is in the [guide](GUIDE.md#settings)): change them, then restart it (`tenzo service install` again for the service, which bakes the shell's environment into its plist).

**Why two routes.** Threads' live apps are whatever an agent's dev server serves. On Tenzo's own origin such a page could use your cookie to answer your cards and start threads, so they get an origin of their own: the live listener (`TENZO_LIVE_PORT`, default the daemon's port + 1), with its own credential. Without the second route everything works except Open live from the phone.

## Pairing a phone

`tenzo pair` prints a one-time link and its QR code. It works once, within 10 minutes; the browser that opens it gets its own long-lived token (a cookie) and lands on the Pass.

- **Safari:** scan the QR code with the camera.
- **The home-screen app** (Safari → Share → Add to Home Screen) keeps cookies of its own, so pairing Safari doesn't pair the app, and the camera always opens links in Safari. Open the app instead (it shows "Pair this device"), copy the link on the Mac and paste it into the app's **Or paste its link** field (Universal Clipboard carries it over). Each one is its own device. Open live works from the app too: its links carry their own pass into Safari.

**Open live links are personal.** Whoever opens yours within the hour gets your device's access to threads' live apps (not to Tenzo) for up to a day, or until you revoke the device. Don't paste them into chats.

## Notifications

A paired device can get a notification when a thread is stuck waiting on it (a question, a permission, a proposal, an error or budget pause, a PR ready to merge), never for finished work. One notification per thread, replaced by the newest card; none while Tenzo is open and in view on that device, none to a muted device, and none on the Mac itself. They go through the browser's own push service (Apple's for iPhone), outbound from the daemon, so a tailnet-only daemon still reaches your phone.

**On iPhone** (iOS 16.4 or later), only the home-screen app gets them:

1. Pair Safari, open Tenzo, Share → **Add to Home Screen**.
2. Open Tenzo from the Home Screen and pair it too (paste a fresh `tenzo pair` link into its field).
3. Threads → the phone icon → **Turn on notifications**, and allow. Tap **Test**.
4. Lock the phone and get a thread to ask something: the notification arrives within seconds, and tapping it opens that card.

Each device's card in Devices has *Mute* / *Unmute*, *Test* and *Turn off*.

**What they say**: the thread's name and one short line (the question, or "Allow Bash?" for a permission; never the command, its input or context), cut to 60 and 120 characters. They are encrypted to your browser, but Apple or Google still see when and how big. `TENZO_PUSH_PREVIEW=none` makes each one just "Tenzo · A thread needs you." When you open Tenzo it clears the notifications of threads that no longer need you.

## Devices

```bash
tenzo devices                    # id, name, when paired, last seen
tenzo devices rename <id> <name…>
tenzo devices revoke <id>        # its token stops working; its open connections close at once
```

The app shows the same list under Threads → the phone icon, with Rename and Revoke. A revoked device needs a new `tenzo pair` to come back; new devices are paired from the Mac only. Removing the Serve routes cuts every remote device off at once; the Mac keeps working.

## Never raw TCP

> **Never forward raw TCP to Tenzo**: not `tailscale serve --tcp` or `--tls-terminated-tcp`, not `socat`, `ssh -R` or an ngrok TCP tunnel. They add no forwarding headers and let the client send `Host: localhost`, so **every client through them is local, with no pairing at all**. Use `tailscale serve --https` (an HTTP proxy) only. The same goes for any HTTP proxy that rewrites Host to loopback and drops the forwarding headers.

`tenzo pair --tailscale` refuses to run while a raw TCP route points at Tenzo's ports, and never makes one. (An SSH tunnel *to* the daemon, `ssh -L` from elsewhere, is local too: that is the Mac's own login.)

## Troubleshooting

**`Host "my-mac.tail1234.ts.net" is not allowed` (403).** Add the tailnet name to `TENZO_ALLOWED_HOSTS` and restart the daemon, or run `tenzo pair --tailscale`.

**"Paired, but this browser didn't keep Tenzo's cookie."** The cookie needs HTTPS: open Tenzo by its Serve address (`https://<name>:8443`), not `http://`, an IP address, or a raw TCP forward.

**"This pairing link has expired or was already used."** Links work once, for 10 minutes. Run `tenzo pair` again.

**`tenzo pair`: "The daemon doesn't know where devices reach it."** Set `TENZO_PUBLIC_URL` (or run `tenzo pair --tailscale`), or pass `--url https://<name>:8443`.

**Port in use.** `127.0.0.1:4780 is already in use`: another `tenzo serve` (or the service) is running, or something else holds the port. Stop it, or set `TENZO_PORT` and re-run `tenzo pair --tailscale` so the routes follow. On the tailnet side, `--tailscale` moves to the next free port by itself, or takes `--https-port`.

**The page doesn't load on the phone.** Is the phone's Tailscale on, in the same tailnet? `tailscale serve status` should list both routes, and `https://<name>:8443/health` should answer from any device on the tailnet.

**Open live doesn't open.** `TENZO_LIVE_ORIGIN` must name the live route exactly (`https://<name>:8444`), and that route must point at `TENZO_LIVE_PORT`.

**Tailscale isn't connected, or has no MagicDNS name.** Run `tailscale up` (or sign in from the menu bar) and turn MagicDNS on in the admin console's DNS page.

**A hand-started `tenzo serve` and the service.** Both want the same `TENZO_HOME`; the first keeps it and the service retries every 10 s. Stop the hand-started one to let the service take over.
