import type { ProjectView, QueueItem, ThreadView, UserInputQuestion } from '@tenzo/client-runtime';

/** Test-only records that pass the contracts. */

export const at = '2026-10-03T10:00:00.000Z';

export function question(
	text: string,
	labels: string[],
	recommended: string | null = null
): UserInputQuestion {
	return {
		id: text,
		header: '',
		question: text,
		// Claude's own label is the value; the card shows it without "(Recommended)".
		options: labels.map((label) => ({
			label,
			value: label === recommended ? `${label} (Recommended)` : label,
			description: `Why ${label}`,
			recommended: label === recommended
		})),
		multiSelect: false
	};
}

export function item(tag: string, overrides: Partial<QueueItem> = {}): QueueItem {
	const questions = overrides.questions ?? [question('Which color?', ['Red', 'Blue'], 'Blue')];
	return {
		id: `itm_${tag.repeat(20).slice(0, 20)}`,
		environmentId: 'env_abcdefghij0123456789',
		threadId: 'thr_aaaaaaaaaaaaaaaaaaaa',
		lane: 'quick',
		kind: 'question',
		requestId: `req_${tag.repeat(20).slice(0, 20)}`,
		context: '',
		ask: questions[0]?.question ?? '',
		options: questions[0]?.options ?? [],
		suggested: questions[0]?.options.find((o) => o.recommended)?.value ?? null,
		questions,
		createdAt: at,
		status: 'open',
		detached: false,
		resolvedAt: null,
		resolution: null,
		snoozedUntil: null,
		...overrides
	};
}

export function thread(tag: string, overrides: Partial<ThreadView> = {}): ThreadView {
	return {
		id: `thr_${tag.repeat(20).slice(0, 20)}`,
		environmentId: 'env_abcdefghij0123456789',
		projectId: 'prj_pppppppppppppppppppp',
		projectName: 'app',
		title: `Thread ${tag}`,
		branch: `tenzo/${tag}`,
		worktreePath: `/tmp/${tag}`,
		status: 'active',
		agent: 'claude',
		model: null,
		createdAt: at,
		updatedAt: at,
		archivedAt: null,
		phase: 'discussing',
		origin: 'user',
		parentId: null,
		wakeAt: null,
		activity: 'idle',
		working: false,
		queued: 0,
		openItems: 0,
		lastSeq: 4,
		activeAt: at,
		...overrides
	};
}

export function project(name: string): ProjectView {
	return {
		id: `prj_${name.charAt(0).repeat(20)}`,
		environmentId: 'env_abcdefghij0123456789',
		name,
		defaultBranch: 'main'
	};
}

export function permission(tag: string, suggested: string | null = 'allow'): QueueItem {
	return item(tag, {
		kind: 'permission',
		ask: 'Allow Bash: uname -a?',
		options: [
			{ label: 'Allow', value: 'allow', description: '', recommended: true },
			{ label: 'Deny', value: 'deny', description: '', recommended: false }
		],
		suggested,
		questions: [],
		permission: { toolKind: 'command', toolName: 'Bash', detail: 'uname -a', input: {} }
	});
}

export function failure(tag: string, message = 'API Error: 529 Overloaded'): QueueItem {
	return item(tag, {
		kind: 'error',
		ask: "Claude's turn failed",
		options: [
			{ label: 'Retry', value: 'retry', description: '', recommended: true },
			{ label: 'Archive', value: 'archive', description: '', recommended: false }
		],
		suggested: 'retry',
		questions: [],
		error: { cause: 'turn', message, prompts: ['Fix it'] }
	});
}

export function proposal(tag: string, summary = 'Add CONTRIBUTING.md with three rules.'): QueueItem {
	return item(tag, {
		kind: 'proposal',
		ask: 'Add CONTRIBUTING.md',
		options: [{ label: 'Build it', value: 'build', description: '', recommended: true }],
		suggested: 'build',
		questions: [],
		proposal: { headline: 'Add CONTRIBUTING.md', summary }
	});
}

export function ready(tag: string, url = 'https://github.com/o/r/pull/12'): QueueItem {
	return item(tag, {
		kind: 'ready',
		ask: 'PR #12 can merge',
		options: [{ label: 'Merge', value: 'merge', description: '', recommended: true }],
		suggested: 'merge',
		questions: [],
		ready: { url, summary: 'Checks green, **one** approval.' }
	});
}

export function finished(
	tag: string,
	overrides: Partial<NonNullable<QueueItem['finished']>> = {}
): QueueItem {
	return item(tag, {
		kind: 'finished',
		lane: 'review',
		ask: 'Counter works',
		options: [
			{ label: 'Merge', value: 'merge', description: '', recommended: true },
			{ label: 'Open PR', value: 'pr', description: '', recommended: false },
			{ label: 'Done', value: 'done', description: '', recommended: false }
		],
		suggested: 'merge',
		questions: [],
		finished: {
			headline: 'Counter works',
			summary: 'Added a **counter** page.',
			howToTest: 'Open it and tap `+`.',
			checks: [
				{ name: 'Tests', status: 'pass', detail: '3 passed' },
				{ name: 'Lint', status: 'fail', detail: 'unused import' },
				{ name: 'E2E', status: 'skipped' }
			],
			attachments: [
				{
					id: 'att_aaaaaaaaaaaaaaaaaaaa',
					file: 'att_aaaaaaaaaaaaaaaaaaaa.png',
					name: 'counter.png',
					caption: 'The counter',
					mediaType: 'image/png',
					bytes: 100
				}
			],
			live: { port: 5173, path: 'counter' },
			...overrides
		}
	});
}
