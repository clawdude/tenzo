import type { ConnectionSnapshot } from '@tenzo/client-runtime';

/**
 * What the Pass says about the daemon connection, in a word or two. Quiet on purpose: the pile
 * dims while the data isn't live, and this line only says why.
 */
export function connectionLabel(snapshot: ConnectionSnapshot): string {
	switch (snapshot.state) {
		case 'closed':
			return 'Not connected';
		case 'connecting':
			return 'Connecting…';
		case 'connected':
			return snapshot.serverVersion ? `Connected · daemon ${snapshot.serverVersion}` : 'Connected';
		case 'reconnecting':
			return 'Reconnecting…';
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
