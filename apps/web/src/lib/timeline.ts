import type { Check, RuntimeEvent, StoredEvent } from '@tenzo/client-runtime';

/**
 * What happened so far (PRODUCT.md §5, the mock-up's B2): a thread's events as rows a person
 * reads, as a pure function so it can be tested. Your prompts, what the agent said, what it asked
 * and how you answered, and its tool calls folded into one line per run of them, each expandable.
 *
 * Built from Tenzo's own events, never Claude's transcript: tool outputs are as the daemon kept
 * them (cut to 2,000 characters), and a subagent's inner steps show only as a count on its call.
 */

export type ToolKind = 'command' | 'file_change' | 'file_read' | 'web' | 'mcp' | 'subagent' | 'tool';

export interface ToolCall {
	key: string;
	/** One line: "Bash: npm test". */
	summary: string;
	toolKind: ToolKind;
	status: 'in_progress' | 'completed' | 'failed';
	/** As the daemon kept it; null when there was none. */
	output: string | null;
	/** Steps a subagent took inside this call. */
	steps: number;
}

interface Base {
	/** Stable across updates: the same row keeps its key as the thread goes on. */
	key: string;
	/** When it happened (ISO). */
	at: string;
}

export type Row = Base &
	(
		| { kind: 'prompt'; text: string }
		| { kind: 'said'; text: string }
		| { kind: 'thought'; text: string }
		| { kind: 'tools'; title: string; calls: ToolCall[]; running: boolean; failed: number }
		| { kind: 'question'; ask: string; answer: string | null }
		| { kind: 'permission'; detail: string; answer: string | null }
		| { kind: 'proposal'; headline: string; summary: string; answer: string | null }
		| { kind: 'report'; headline: string; summary: string; checks: Check[]; answer: string | null }
		| { kind: 'note'; text: string; tone: 'quiet' | 'fail' }
	);

export type RowKind = Row['kind'];

type ItemEvent = Extract<RuntimeEvent, { type: 'item.started' | 'item.completed' }>;

/** Tool calls the timeline shows as what they did instead: a question, a proposal, a report. */
const OWN_ROWS = /^(AskUserQuestion|mcp__tenzo__\w+)$/;

/**
 * The thread's events → rows, oldest first. Events must be in log order (a feed's are). Paths
 * inside `root` (the thread's worktree) are shown relative to it.
 */
export function timelineOf(events: readonly StoredEvent[], root = ''): Row[] {
	const inside = root.replace(/\/+$/, '') + '/';
	const short = (text: string) => (inside.length > 1 ? text.replaceAll(inside, '') : text);
	const rows: Row[] = [];
	/** Rows that later events fill in: tool calls by item id, asks by request id. */
	const calls = new Map<string, ToolCall>();
	const asks = new Map<string, Row>();
	/** The open run of tool calls, which the next tool joins. */
	let run: Extract<Row, { kind: 'tools' }> | null = null;
	const prompted = new Set<string>();
	const failedTurns = new Set<string>();

	const push = (row: Row) => {
		run = null;
		rows.push(row);
	};

	const onTool = (event: ItemEvent, at: string) => {
		const p = event.payload;
		// Asking you and Tenzo's own tools have rows of their own (the ask, the report, the note).
		if (p.toolName && OWN_ROWS.test(p.toolName)) return;
		const parent = p.parentItemId ? calls.get(p.parentItemId) : undefined;
		if (p.parentItemId) {
			// A subagent's own step: counted on its call, not shown as a row of its own.
			if (parent && event.type === 'item.started') parent.steps++;
			return;
		}
		let call = calls.get(event.itemId);
		if (!call) {
			call = {
				key: event.itemId,
				summary: short(p.text || p.toolName || 'A tool'),
				toolKind: (p.toolKind ?? 'tool') as ToolKind,
				status: p.status,
				output: null,
				steps: 0
			};
			calls.set(event.itemId, call);
			if (!run) {
				run = { kind: 'tools', key: `tools:${event.itemId}`, at, title: '', calls: [], running: false, failed: 0 };
				rows.push(run);
			}
			run.calls.push(call);
		}
		if (event.type === 'item.completed') {
			call.status = p.status;
			if (p.output !== undefined) call.output = p.output;
		}
	};

	for (const { seq, event } of events) {
		const at = event.createdAt;
		switch (event.type) {
			case 'turn.started':
				if (event.payload.prompt) {
					prompted.add(event.turnId);
					push({ kind: 'prompt', key: `prompt:${event.turnId}`, at, text: event.payload.prompt });
				}
				break;
			case 'item.started':
			case 'item.completed': {
				const p = event.payload;
				if (p.itemType === 'tool') {
					onTool(event, at);
					break;
				}
				// Messages and thoughts arrive completed; a subagent's own words stay inside it.
				if (event.type !== 'item.completed' || p.parentItemId || !p.text?.trim()) break;
				if (p.itemType === 'user_message') {
					if (!prompted.has(event.itemId)) {
						push({ kind: 'prompt', key: `prompt:${event.itemId}`, at, text: p.text });
					}
				} else if (p.itemType === 'assistant_message') {
					push({ kind: 'said', key: `said:${event.itemId}`, at, text: p.text });
				} else {
					push({ kind: 'thought', key: `thought:${event.itemId}`, at, text: p.text });
				}
				break;
			}
			case 'user-input.requested': {
				const ask = event.payload.questions.map((q) => q.question).join(' · ');
				const row: Row = { kind: 'question', key: `ask:${event.requestId}`, at, ask, answer: null };
				asks.set(event.requestId, row);
				push(row);
				break;
			}
			case 'user-input.resolved':
				answer(asks, event.requestId, event.payload.cancelled ? 'Withdrawn' : Object.values(event.payload.answers).join(' · '));
				break;
			case 'request.opened': {
				const row: Row = {
					kind: 'permission',
					key: `ask:${event.requestId}`,
					at,
					detail: short(event.payload.title || event.payload.detail),
					answer: null
				};
				asks.set(event.requestId, row);
				push(row);
				break;
			}
			case 'request.resolved': {
				const { decision, message } = event.payload;
				const said = decision === 'allow' ? 'Allowed' : decision === 'deny' ? 'Denied' : 'Withdrawn';
				answer(asks, event.requestId, message ? `${said}: ${message}` : said);
				break;
			}
			case 'proposal.requested': {
				const row: Row = {
					kind: 'proposal',
					key: `ask:${event.requestId}`,
					at,
					headline: event.payload.headline,
					summary: event.payload.summary,
					answer: null
				};
				asks.set(event.requestId, row);
				push(row);
				break;
			}
			case 'proposal.resolved': {
				const { decision, note } = event.payload;
				answer(
					asks,
					event.requestId,
					decision === 'build' ? 'Build it' : decision === 'change' ? `Change: ${note ?? ''}`.trim() : 'Withdrawn'
				);
				break;
			}
			case 'report.submitted': {
				const row: Row = {
					kind: 'report',
					key: `ask:${event.requestId}`,
					at,
					headline: event.payload.headline || 'Ready for review',
					summary: event.payload.summary,
					checks: event.payload.checks,
					answer: null
				};
				asks.set(event.requestId, row);
				push(row);
				break;
			}
			case 'report.resolved':
				answer(asks, event.requestId, 'Done');
				break;
			case 'attachment.added': {
				const a = event.payload.attachment;
				push({ kind: 'note', key: `note:${seq}`, at, text: `Attached ${a.caption || a.name}`, tone: 'quiet' });
				break;
			}
			case 'preview.exposed':
				push({ kind: 'note', key: `note:${seq}`, at, text: `Exposed its app on port ${event.payload.port}`, tone: 'quiet' });
				break;
			case 'runtime.error':
				if (event.turnId) failedTurns.add(event.turnId);
				push({ kind: 'note', key: `note:${seq}`, at, text: event.payload.message, tone: 'fail' });
				break;
			case 'turn.completed': {
				const { state, errorMessage } = event.payload;
				if (state === 'interrupted') {
					push({ kind: 'note', key: `note:${seq}`, at, text: 'Stopped', tone: 'quiet' });
				} else if (state === 'failed' && !failedTurns.has(event.turnId)) {
					push({ kind: 'note', key: `note:${seq}`, at, text: errorMessage || 'The turn failed', tone: 'fail' });
				}
				break;
			}
			case 'session.exited':
				if (event.payload.exitKind === 'error') {
					const why = event.payload.reason ? `: ${event.payload.reason}` : '';
					push({ kind: 'note', key: `note:${seq}`, at, text: `The agent stopped${why}`, tone: 'quiet' });
				}
				break;
			case 'thread.archived':
				push({ kind: 'note', key: `note:${seq}`, at, text: 'Archived', tone: 'quiet' });
				break;
			default:
				// Sessions starting and their configuration: nothing to read.
				break;
		}
	}

	for (const row of rows) {
		if (row.kind !== 'tools') continue;
		row.title = runTitle(row.calls);
		row.running = row.calls.some((c) => c.status === 'in_progress');
		row.failed = row.calls.filter((c) => c.status === 'failed').length;
	}
	return rows;
}

function answer(asks: Map<string, Row>, requestId: string, said: string): void {
	const row = asks.get(requestId);
	if (row && 'answer' in row) row.answer = said;
}

const VERBS: Record<ToolKind, [one: string, many: (n: number) => string]> = {
	file_read: ['Read a file', (n) => `Read ${n} files`],
	file_change: ['Edited a file', (n) => `Edited ${n} files`],
	command: ['Ran a command', (n) => `Ran ${n} commands`],
	web: ['Looked on the web', (n) => `Looked on the web ${n} times`],
	mcp: ['Used a tool', (n) => `Used ${n} tools`],
	subagent: ['Sent a subagent', (n) => `Sent ${n} subagents`],
	tool: ['Used a tool', (n) => `Used ${n} tools`]
};

/**
 * A run of tool calls in a few words: one call is its own summary; several are counted by
 * kind, most first ("Read 9 files · Ran 2 commands").
 */
export function runTitle(calls: readonly ToolCall[]): string {
	if (calls.length === 1) return calls[0]?.summary ?? '';
	const counts = new Map<ToolKind, number>();
	for (const c of calls) counts.set(c.toolKind, (counts.get(c.toolKind) ?? 0) + 1);
	const parts = [...counts]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 2)
		.map(([kind, n]) => (n === 1 ? VERBS[kind][0] : VERBS[kind][1](n)));
	const shown = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).reduce((s, [, n]) => s + n, 0);
	const rest = calls.length - shown;
	return rest > 0 ? `${parts.join(' · ')} · ${rest} more` : parts.join(' · ');
}

/** Text cut for showing collapsed: `head`, and whether there is more to show. */
export interface Clipped {
	head: string;
	more: boolean;
}

/**
 * The start of `text`, at most `chars` characters and `lines` lines, cut at a line or word end
 * when one is near. Long outputs stay collapsed until asked for.
 */
export function clip(text: string, { chars, lines }: { chars: number; lines: number }): Clipped {
	let head = text;
	const byLines = head.split('\n');
	if (byLines.length > lines) head = byLines.slice(0, lines).join('\n');
	if (head.length > chars) {
		const cut = head.slice(0, chars);
		const space = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
		head = space > chars * 0.6 ? cut.slice(0, space) : cut;
	}
	head = head.trimEnd();
	return { head, more: head.length < text.trimEnd().length };
}

/**
 * The rows to draw: the last `count` of them. A long thread draws only its end; "Earlier" adds
 * a page at a time, so a phone never lays out thousands of rows.
 */
export function windowOf<T>(rows: readonly T[], count: number): { shown: readonly T[]; hidden: number } {
	const hidden = Math.max(0, rows.length - count);
	return { shown: hidden > 0 ? rows.slice(hidden) : rows, hidden };
}

/** How many rows one "Earlier" adds. */
export const ROW_PAGE = 60;

/** The agent's latest session id in the events: what resumes its full transcript. */
export function sessionOf(events: readonly StoredEvent[]): string | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i]?.event;
		if (event?.type === 'session.started') return event.payload.sessionId;
	}
	return null;
}

/** "14:02": when a row happened, in this browser's time. */
export function clockOf(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '';
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
