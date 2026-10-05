import type {
	AutomationProblem,
	AutomationRunView,
	AutomationView
} from '@tenzo/client-runtime';
import { ageLabel } from './pass.ts';
import { untilLabel } from './threads.ts';

/**
 * The Automations list's logic (PRODUCT.md §7; the full screen is post-MVP): each automation
 * with its schedule in words, when it runs next, and its last run in one line. Kept out of the
 * component so it can be tested.
 */

/**
 * The last run's dot: clay waits on you (a question, an error, its budget), blue is running,
 * green ran, red failed to start, grey skipped or long gone.
 */
export type RunTone = 'clay' | 'working' | 'done' | 'fail' | 'quiet';

export interface LastRunLine {
	/** "Ran 2h ago · $0.12", "Skipped 5m ago: its previous run is still going." */
	text: string;
	tone: RunTone;
	/** The run's thread, to open; null when it started none. */
	threadId: string | null;
}

export interface AutomationRow {
	key: string;
	automation: AutomationView;
	/** "every hour", "every day at 09:00", "by hand". */
	schedule: string;
	/** "in 12m", "due now", "paused", "switched off"; null when nothing is scheduled. */
	next: string | null;
	last: LastRunLine;
}

export interface ProjectGroup {
	key: string;
	projectName: string;
	/** Why the project's config can't be read (none of its automations run); null when it can. */
	problem: string | null;
	rows: AutomationRow[];
}

const UNIT_WORDS: Record<string, [string, string]> = {
	m: ['minute', 'minutes'],
	h: ['hour', 'hours'],
	d: ['day', 'days']
};

/**
 * A schedule as a person says it: "every 15 minutes", "every hour, on the hour", "every day at
 * 09:00", "weekdays at 09:00", or the cron line as written. A clock time in a zone other than the
 * viewer's says which; null (no schedule) is "by hand".
 */
export function scheduleInWords(
	schedule: string | null,
	timeZone: string,
	viewerZone: string = localZone()
): string {
	if (schedule === null) return 'by hand';
	const text = schedule.trim().replaceAll(/\s+/g, ' ');
	const every = /^every (\d+) ?(m|h|d)$/i.exec(text);
	if (every) {
		const n = Number(every[1]);
		const [one, many] = UNIT_WORDS[every[2]!.toLowerCase()] ?? ['minute', 'minutes'];
		return n === 1 ? `every ${one}` : `every ${n} ${many}`;
	}
	const zone = timeZone === viewerZone ? '' : ` (${timeZone})`;
	if (/^hourly$/i.test(text)) return `every hour, on the hour${zone}`;
	const clock = /^(daily|weekdays) (\d{1,2}):(\d{2})$/i.exec(text);
	if (clock) {
		const time = `${clock[2]!.padStart(2, '0')}:${clock[3]}`;
		const days = clock[1]!.toLowerCase() === 'daily' ? 'every day' : 'weekdays';
		return `${days} at ${time}${zone}`;
	}
	return `cron ${text}${zone}`;
}

/**
 * When it runs next, in a word: "in 12m", "due now" (its time came; the daemon is starting it),
 * "paused" (the off switch), "switched off" (`enabled: false`). Null when it runs only by hand,
 * or its next time isn't worked out yet.
 */
export function nextRunLabel(automation: AutomationView, paused: boolean, now: number): string | null {
	if (automation.schedule === null) return null;
	if (!automation.enabled) return 'switched off';
	if (paused) return 'paused';
	if (automation.nextRunAt === null) return null;
	if (Date.parse(automation.nextRunAt) <= now) return 'due now';
	return `in ${untilLabel(automation.nextRunAt, now)}`;
}

/**
 * The last run in one line: whether it ran (and where it is now: running, waiting on you, paused
 * by its budget, done, archived), was skipped and why, or failed to start and why; with what it
 * spent, as Claude reports it.
 */
export function lastRunLine(run: AutomationRunView | null, now: number): LastRunLine {
	if (run === null) return { text: 'Never ran', tone: 'quiet', threadId: null };
	const age = ageLabel(run.at, now);
	const when = age === 'now' ? 'just now' : `${age} ago`;
	const hand = run.trigger === 'manual' ? ' by hand' : '';
	const cost = run.costUsd === null ? '' : ` · $${run.costUsd.toFixed(2)}`;
	if (run.result === 'skipped') {
		return { text: `Skipped ${when}: ${reasonOf(run.reason)}`, tone: 'quiet', threadId: null };
	}
	if (run.result === 'failed') {
		return { text: `Failed to start ${when}: ${reasonOf(run.reason)}`, tone: 'fail', threadId: null };
	}
	const threadId = run.threadId;
	switch (run.state) {
		case 'going':
			return { text: `Running · started${hand} ${when}${cost}`, tone: 'working', threadId };
		case 'waiting':
			return { text: `Waiting on you · ran${hand} ${when}${cost}`, tone: 'clay', threadId };
		case 'paused':
			return { text: `Paused by its budget · ran${hand} ${when}${cost}`, tone: 'clay', threadId };
		case 'archived':
			return { text: `Ran${hand} ${when} · archived${cost}`, tone: 'quiet', threadId };
		default:
			return { text: `Ran${hand} ${when}${cost}`, tone: 'done', threadId };
	}
}

/** The daemon's reason, without the thread id it names (the line links the thread itself). */
function reasonOf(reason: string | null): string {
	if (!reason) return 'no reason given.';
	return reason.replace(/ \(thr_[A-Za-z0-9]+\)/g, '');
}

/**
 * The list: projects by name, each with its automations in the config's order, and a project
 * whose config can't be read with why (it lists none: none of them run).
 */
export function automationGroups(
	automations: readonly AutomationView[],
	problems: readonly AutomationProblem[],
	paused: boolean,
	now: number,
	viewerZone: string = localZone()
): ProjectGroup[] {
	const groups = new Map<string, ProjectGroup>();
	const groupOf = (projectId: string, projectName: string) => {
		let group = groups.get(projectId);
		if (!group) {
			group = { key: projectId, projectName, problem: null, rows: [] };
			groups.set(projectId, group);
		}
		return group;
	};
	for (const problem of problems) {
		groupOf(problem.projectId, problem.projectName).problem = problem.problem;
	}
	for (const automation of automations) {
		groupOf(automation.projectId, automation.projectName).rows.push({
			key: `${automation.projectId}/${automation.name}`,
			automation,
			schedule: scheduleInWords(automation.schedule, automation.timeZone, viewerZone),
			next: nextRunLabel(automation, paused, now),
			last: lastRunLine(automation.lastRun, now)
		});
	}
	return [...groups.values()].sort((a, b) => a.projectName.localeCompare(b.projectName));
}

/**
 * The list in a few words, for the screens that link to it: "paused", "next in 12m" (the
 * soonest scheduled run), "by hand" (nothing scheduled); null when there are none.
 */
export function automationsSummary(
	automations: readonly AutomationView[],
	paused: boolean,
	now: number
): string | null {
	if (automations.length === 0) return null;
	const scheduled = automations.filter((a) => a.schedule !== null && a.enabled);
	if (paused && scheduled.length > 0) return 'paused';
	const times = scheduled
		.map((a) => (a.nextRunAt === null ? Number.NaN : Date.parse(a.nextRunAt)))
		.filter((t) => !Number.isNaN(t));
	if (times.length === 0) return scheduled.length > 0 ? 'scheduled' : 'by hand';
	const soonest = Math.min(...times);
	return soonest <= now ? 'due now' : `next in ${untilLabel(new Date(soonest).toISOString(), now)}`;
}

/** What Run now got: the thread to open, or why nothing started. */
export function runOutcome(result: {
	run: AutomationRunView;
	thread: { id: string } | null;
}): { threadId: string } | { message: string } {
	if (result.run.result === 'started' && result.thread) return { threadId: result.thread.id };
	const verb = result.run.result === 'skipped' ? 'Skipped' : "Couldn't start it";
	return { message: `${verb}: ${reasonOf(result.run.reason)}` };
}

/** What archiving finished runs did, in a line. */
export function archiveOutcome(result: {
	archived: readonly unknown[];
	kept: readonly { reason: string }[];
}): string {
	const n = result.archived.length;
	const done =
		n === 0
			? 'Nothing archived.'
			: `Archived ${n} finished run${n === 1 ? '' : 's'}; branches kept.`;
	if (result.kept.length === 0) return done;
	const k = result.kept.length;
	return `${done} Kept ${k}: ${result.kept[0]?.reason ?? ''}`;
}

function localZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone;
	} catch {
		return 'UTC';
	}
}
