import type { QueueItem, UserInputQuestion } from '@tenzo/client-runtime';

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
		...overrides
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
