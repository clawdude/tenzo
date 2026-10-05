import {
	type Command,
	type CommandResult,
	CommandError,
	EMPTY,
	emptyFeed,
	type Feed,
	fetchSession,
	TenzoClient,
	type TenzoState
} from '@tenzo/client-runtime';
import { grantStale } from './devices.ts';
import { daemonSocketUrl } from './status.ts';

/**
 * The app's one connection to the daemon, shared by every screen: the Pass, New thread and the
 * Threads list read the same live state, and moving between them never reconnects.
 */
class Tenzo {
	/** The connection and the daemon's projects, threads and open items, live. */
	state = $state.raw<TenzoState>({
		...EMPTY,
		connection: {
			state: 'closed',
			attempt: 0,
			environmentId: null,
			serverVersion: null,
			clockOffset: 0,
			probing: false
		},
		synced: false
	});
	/** The daemon's data has arrived at least once; until then an empty list means nothing. */
	seen = $state(false);
	/** Connected right now: commands can go. */
	online = $derived(this.state.connection.state === 'connected');
	/**
	 * Who the daemon takes this browser for (PRODUCT.md §9): `unknown` until it says; `local` on the
	 * Mac itself; `paired`; `unpaired` from elsewhere without a pairing, when the app shows how to
	 * pair instead of a Pass that can't load (and opens no socket).
	 */
	access = $state<'unknown' | 'local' | 'paired' | 'unpaired'>('unknown');
}

export const tenzo = new Tenzo();

let client: TenzoClient | null = null;

/** Screens following a thread's events, attached to whichever client is open. */
interface Watcher {
	threadId: string;
	listener: (feed: Feed) => void;
	detach: (() => void) | null;
}
const watchers = new Set<Watcher>();

/** Closes the open client, if any. */
let closeClient: (() => void) | null = null;

/**
 * Asks the daemon who this browser is, then opens the connection unless it is an unpaired device
 * from elsewhere (the app's layout does, once). Returns the close function.
 */
export function connectTenzo(): () => void {
	let closed = false;
	void fetchSession().then((session) => {
		if (closed) return;
		if (session?.mode === 'remote' && !session.device) {
			tenzo.access = 'unpaired';
			return;
		}
		tenzo.access = !session ? 'unknown' : session.mode === 'local' ? 'local' : 'paired';
		openClient();
	});
	return () => {
		closed = true;
		closeClient?.();
	};
}

/** Just paired (the pair page): connect now. */
export function resumeTenzo(): void {
	tenzo.access = 'paired';
	if (!client) openClient();
}

function openClient(): void {
	const opened = new TenzoClient({ url: daemonSocketUrl(location) });
	client = opened;
	/** A session check is out: one at a time. */
	let checking = false;
	let lastAttempt = 0;
	const unsubscribe = opened.subscribe((next) => {
		if (next.synced) tenzo.seen = true;
		tenzo.state = next;
		// A socket that keeps failing may be a device that was unpaired (revoked): ask once per
		// attempt, and show how to pair rather than reconnecting forever.
		const { state, attempt } = next.connection;
		if (state === 'reconnecting' && attempt !== lastAttempt && !checking) {
			lastAttempt = attempt;
			checking = true;
			void fetchSession().then((session) => {
				checking = false;
				if (session?.mode === 'remote' && !session.device && client === opened) {
					tenzo.access = 'unpaired';
					closeClient?.();
				}
			});
		}
	});
	// Screens may start watching before the layout connects (children mount first).
	for (const w of watchers) w.detach = opened.watch(w.threadId, w.listener);
	opened.connect();
	// Back on the page with a stale Open live grant (the socket slept through its renewals): a
	// new socket now, whose snapshot brings a fresh one before Open live is tapped.
	const onResume = () => {
		if (document.visibilityState === 'hidden' || client !== opened) return;
		const { live, connection } = tenzo.state;
		if (grantStale(live?.grant, Date.now() + connection.clockOffset)) {
			opened.connection.wake({ away: Number.POSITIVE_INFINITY });
		}
	};
	document.addEventListener('visibilitychange', onResume);
	window.addEventListener('pageshow', onResume);
	closeClient = () => {
		document.removeEventListener('visibilitychange', onResume);
		window.removeEventListener('pageshow', onResume);
		for (const w of watchers) {
			w.detach?.();
			w.detach = null;
		}
		unsubscribe();
		opened.close();
		if (client === opened) client = null;
		closeClient = null;
	};
}

/**
 * Follows a thread's events (`TenzoClient.watch`): `listener` gets its feed now and on every
 * change, live. Returns the unwatch, for an `$effect` to return.
 */
export function watchThread(threadId: string, listener: (feed: Feed) => void): () => void {
	const watcher: Watcher = { threadId, listener, detach: null };
	watchers.add(watcher);
	listener(client?.feed(threadId) ?? emptyFeed(threadId));
	if (client) watcher.detach = client.watch(threadId, listener);
	return () => {
		watchers.delete(watcher);
		watcher.detach?.();
	};
}

/** Pages earlier events into a watched thread's feed. */
export function loadOlder(threadId: string): Promise<void> {
	return client ? client.loadOlder(threadId) : Promise.resolve();
}

/** Runs a command on the daemon (see `TenzoClient.command`). */
export function command<C extends Command>(command: C): Promise<CommandResult<C['type']>> {
	if (!client) {
		return Promise.reject(
			new CommandError('offline', "Not connected to Tenzo. Try again once it's back.")
		);
	}
	return client.command(command);
}
