import type { ConnectionSnapshot } from '@tenzo/client-runtime';

/** What the shell says about the daemon connection, in one short line. */
export function connectionLabel(snapshot: ConnectionSnapshot): string {
	switch (snapshot.state) {
		case 'closed':
			return 'Not connected';
		case 'connecting':
			return 'Connecting…';
		case 'connected':
			return snapshot.serverVersion ? `Connected · daemon ${snapshot.serverVersion}` : 'Connected';
		case 'reconnecting':
			return snapshot.attempt > 1 ? `Reconnecting (attempt ${snapshot.attempt})…` : 'Reconnecting…';
	}
}

/** The status dot: live when the daemon said hello, waiting while trying, off when closed. */
export function connectionTone(snapshot: ConnectionSnapshot): 'live' | 'waiting' | 'off' {
	switch (snapshot.state) {
		case 'connected':
			return 'live';
		case 'connecting':
		case 'reconnecting':
			return 'waiting';
		case 'closed':
			return 'off';
	}
}

/**
 * The daemon's WebSocket on the page's own origin. The daemon serves the web app, Vite proxies
 * `/ws` in dev, and Tailscale Serve fronts both with HTTPS, so the socket is always `/ws` next to
 * the page: `wss:` under https (an https page may not open `ws:`), `ws:` otherwise.
 */
export function daemonSocketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
	const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${scheme}//${location.host}/ws`;
}
