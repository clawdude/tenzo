import type { DiffFile, QueueItem, StoredEvent, ThreadDiff } from '@tenzo/client-runtime';

/**
 * The back of the card (PRODUCT.md §5, the mock-ups' B1 and B3), worked out from the item and
 * the thread's events so it can be tested. One tap deeper is the timeline (timeline.ts).
 *
 * - question, permission, proposal: *why it's asking*: what the agent said leading up to the
 *   ask, the options with what each means, and the files it has changed and read so far;
 * - finished: *the change*: files with +/− (`thread.diff`), how to try it, screenshots;
 * - error: what went wrong, in full.
 */

export type BackKind = 'why' | 'change' | 'error';

/** What the More pill says, and what the back's header says, per card. */
export interface BackLabels {
	kind: BackKind;
	/** The pill on the front. */
	pill: string;
	/** The header on the back. */
	title: string;
}

export function backLabels(item: Pick<QueueItem, 'kind'>): BackLabels {
	// Kinds a newer daemon may send (an error card) fall through to what fits them best.
	switch (item.kind as string) {
		case 'question':
			return { kind: 'why', pill: "Why it's asking", title: "Why it's asking" };
		case 'permission':
			return { kind: 'why', pill: 'What exactly', title: 'What exactly' };
		case 'proposal':
			return { kind: 'why', pill: 'What it looked at', title: 'What it looked at' };
		case 'finished':
			return { kind: 'change', pill: 'See the change', title: 'The change' };
		case 'error':
			return { kind: 'error', pill: 'What went wrong', title: 'What went wrong' };
		default:
			return { kind: 'why', pill: 'What happened', title: 'What happened' };
	}
}

export interface Choice {
	label: string;
	description: string;
	/** The card's filled button: the agent's suggestion. */
	suggested: boolean;
}

export interface Weighed {
	/** The question, when there are several; empty for the only one. */
	question: string;
	choices: Choice[];
}

export interface Files {
	/** Paths it wrote, relative to the worktree, latest last. */
	changed: string[];
	/** Paths it read and didn't write. */
	read: string[];
	/** How many more there were than are listed. */
	moreChanged: number;
	moreRead: number;
}

export interface WhyBack {
	/**
	 * What the agent said in the asking turn before it asked, latest last: its reasoning, as
	 * markdown. Falls back to the card's context when the events don't reach back that far.
	 */
	reasoning: string;
	weighed: Weighed[];
	files: Files;
}

/** How much of what it said before asking the back shows. */
export const REASONING_LIMIT = 2400;
/** How many paths of each kind the back lists. */
export const FILES_LIMIT = 12;

export function whyBack(item: QueueItem, events: readonly StoredEvent[], worktreePath: string): WhyBack {
	return {
		reasoning: reasoningOf(item, events),
		weighed: weighedOf(item),
		files: filesOf(events, worktreePath)
	};
}

/**
 * The agent's words in the asking turn, before the ask: every message of its own (not a
 * subagent's) from the turn's start to the ask, the end kept when it's long.
 */
export function reasoningOf(item: QueueItem, events: readonly StoredEvent[]): string {
	const at = events.findIndex(
		({ event }) => 'requestId' in event && event.requestId === item.requestId && isAsk(event.type)
	);
	const asked = at === -1 ? undefined : events[at]?.event;
	const turnId = asked?.turnId ?? item.turnId;
	const said: string[] = [];
	if (turnId) {
		for (const { event } of at === -1 ? events : events.slice(0, at)) {
			if (event.turnId !== turnId || event.type !== 'item.completed') continue;
			const p = event.payload;
			if (p.itemType === 'assistant_message' && !p.parentItemId && p.text?.trim()) said.push(p.text.trim());
		}
	}
	const text = said.join('\n\n') || item.context;
	return text.length <= REASONING_LIMIT ? text : `…${text.slice(text.length - REASONING_LIMIT).trimStart()}`;
}

function isAsk(type: string): boolean {
	return type === 'user-input.requested' || type === 'request.opened' || type === 'proposal.requested';
}

/** Each question's options with what they mean; the suggested one marked. */
export function weighedOf(item: QueueItem): Weighed[] {
	if (item.kind !== 'question') return [];
	const questions =
		item.questions.length > 0
			? item.questions
			: [{ question: item.ask, options: item.options }];
	return questions
		.map((q, i) => ({
			question: questions.length > 1 ? q.question : '',
			choices: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				suggested: i === 0 && item.suggested !== null ? o.value === item.suggested : o.recommended
			}))
		}))
		.filter((w) => w.choices.length > 0);
}

/**
 * The files the thread has written and read so far, as the events say (a Write, an Edit, a
 * Read, by their `file_path`), relative to the worktree. Searches and globs name no one file.
 */
export function filesOf(events: readonly StoredEvent[], worktreePath: string): Files {
	const changed = new Set<string>();
	const read = new Set<string>();
	for (const { event } of events) {
		if (event.type !== 'item.started' || event.payload.itemType !== 'tool') continue;
		const input = event.payload.input;
		if (typeof input !== 'object' || input === null) continue;
		const raw = (input as Record<string, unknown>).file_path ?? (input as Record<string, unknown>).notebook_path;
		if (typeof raw !== 'string' || raw === '' || raw.includes('… (')) continue; // cut by the daemon
		const path = relativeTo(raw, worktreePath);
		if (event.payload.toolKind === 'file_change') {
			read.delete(path);
			changed.delete(path);
			changed.add(path);
		} else if (event.payload.toolKind === 'file_read' && !changed.has(path)) {
			read.delete(path);
			read.add(path);
		}
	}
	const last = (set: Set<string>) => [...set].slice(-FILES_LIMIT);
	return {
		changed: last(changed),
		read: last(read),
		moreChanged: Math.max(0, changed.size - FILES_LIMIT),
		moreRead: Math.max(0, read.size - FILES_LIMIT)
	};
}

/** `path` relative to the worktree when it is inside it; as it is otherwise. */
export function relativeTo(path: string, root: string): string {
	const base = root.replace(/\/+$/, '');
	return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

// The change.

export interface ChangeLine {
	path: string;
	/** "+41", or "" when not counted (binary). */
	added: string;
	/** "−8", or "" for none. */
	deleted: string;
	/** "new", "deleted", "renamed from x", or "binary": a word after the counts. */
	note: string;
}

export interface ChangeView {
	/** "4 files · +118 −12"; "No changes yet" for none. */
	headline: string;
	lines: ChangeLine[];
	/** "And 12 more files" when the daemon listed only some. */
	more: string;
}

const MINUS = '−';

export function changeView(diff: ThreadDiff): ChangeView {
	const files = diff.fileCount === 1 ? '1 file' : `${diff.fileCount} files`;
	const counts = [diff.added > 0 && `+${diff.added}`, diff.deleted > 0 && `${MINUS}${diff.deleted}`]
		.filter(Boolean)
		.join(' ');
	const left = diff.fileCount - diff.files.length;
	return {
		headline: diff.fileCount === 0 ? 'No changes yet' : counts ? `${files} · ${counts}` : files,
		lines: diff.files.map(lineOf),
		more: left > 0 ? `And ${left} more ${left === 1 ? 'file' : 'files'}` : ''
	};
}

function lineOf(file: DiffFile): ChangeLine {
	const binary = file.added === null;
	return {
		path: file.path,
		added: binary ? '' : file.added ? `+${file.added}` : '',
		deleted: file.deleted ? `${MINUS}${file.deleted}` : '',
		note:
			file.status === 'added' || file.status === 'untracked'
				? binary
					? 'new · binary'
					: 'new'
				: file.status === 'deleted'
					? 'deleted'
					: file.status === 'renamed'
						? `from ${file.from ?? '?'}`
						: binary
							? 'binary'
							: ''
	};
}

// What went wrong.

/** An error card's message (#23 sends them); its ask when it carries none. */
export function errorOf(item: QueueItem): string {
	const error = (item as QueueItem & { error?: { message?: unknown } }).error;
	return typeof error?.message === 'string' && error.message.trim() ? error.message : item.ask;
}
