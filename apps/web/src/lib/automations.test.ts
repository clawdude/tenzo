import { describe, expect, it } from 'vitest';
import {
	archiveOutcome,
	automationGroups,
	automationsSummary,
	lastRunLine,
	nextRunLabel,
	runOutcome,
	scheduleInWords
} from './automations.ts';
import { at, automation, run } from './fixtures.ts';

const t0 = Date.parse(at);
const later = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();
const earlier = (minutes: number) => later(-minutes);

describe('scheduleInWords', () => {
	it('says intervals in words', () => {
		expect(scheduleInWords('every 5m', 'UTC', 'UTC')).toBe('every 5 minutes');
		expect(scheduleInWords('every 1h', 'UTC', 'UTC')).toBe('every hour');
		expect(scheduleInWords('every 2h', 'UTC', 'UTC')).toBe('every 2 hours');
		expect(scheduleInWords('every 1d', 'UTC', 'UTC')).toBe('every day');
		// An interval doesn't depend on a zone, so none is named.
		expect(scheduleInWords('every 30m', 'Europe/Rome', 'UTC')).toBe('every 30 minutes');
	});

	it('says clock times, with the zone only when it is not the viewer’s', () => {
		expect(scheduleInWords('daily 9:00', 'Europe/Rome', 'Europe/Rome')).toBe('every day at 09:00');
		expect(scheduleInWords('weekdays 17:30', 'UTC', 'UTC')).toBe('weekdays at 17:30');
		expect(scheduleInWords('hourly', 'UTC', 'UTC')).toBe('every hour, on the hour');
		expect(scheduleInWords('daily 09:00', 'Europe/Rome', 'America/New_York')).toBe(
			'every day at 09:00 (Europe/Rome)'
		);
	});

	it('leaves a cron line as written, and no schedule is by hand', () => {
		expect(scheduleInWords('*/15 9-17 * * 1-5', 'UTC', 'UTC')).toBe('cron */15 9-17 * * 1-5');
		expect(scheduleInWords(null, 'UTC', 'UTC')).toBe('by hand');
	});
});

describe('nextRunLabel', () => {
	it('counts down to the next run', () => {
		expect(nextRunLabel(automation('a', { nextRunAt: later(12) }), false, t0)).toBe('in 12m');
		expect(nextRunLabel(automation('a', { nextRunAt: later(150) }), false, t0)).toBe('in 3h');
		expect(nextRunLabel(automation('a', { nextRunAt: earlier(1) }), false, t0)).toBe('due now');
	});

	it('says paused, switched off, or nothing for one run by hand', () => {
		expect(nextRunLabel(automation('a', { nextRunAt: later(12) }), true, t0)).toBe('paused');
		expect(nextRunLabel(automation('a', { enabled: false }), true, t0)).toBe('switched off');
		expect(nextRunLabel(automation('a', { schedule: null }), true, t0)).toBeNull();
		expect(nextRunLabel(automation('a', { nextRunAt: null }), false, t0)).toBeNull();
	});
});

describe('lastRunLine', () => {
	it('says a run never happened', () => {
		expect(lastRunLine(null, t0)).toEqual({ text: 'Never ran', tone: 'quiet', threadId: null });
	});

	it('says where a started run is, with its cost, and links its thread', () => {
		const id = run().threadId;
		expect(lastRunLine(run({ costUsd: 0.123 }), t0 + 2 * 3_600_000)).toEqual({
			text: 'Ran 2h ago · $0.12',
			tone: 'done',
			threadId: id
		});
		expect(lastRunLine(run({ state: 'going', trigger: 'manual' }), t0 + 4 * 60_000)).toEqual({
			text: 'Running · started by hand 4m ago',
			tone: 'working',
			threadId: id
		});
		expect(lastRunLine(run({ state: 'waiting', costUsd: 0.1 }), t0)).toMatchObject({
			text: 'Waiting on you · ran just now · $0.10',
			tone: 'clay'
		});
		expect(lastRunLine(run({ state: 'paused', costUsd: 2.04 }), t0 + 60 * 60_000)).toMatchObject({
			text: 'Paused by its budget · ran 1h ago · $2.04',
			tone: 'clay'
		});
		expect(lastRunLine(run({ state: 'archived' }), t0 + 3 * 86_400_000)).toMatchObject({
			text: 'Ran 3d ago · archived',
			tone: 'quiet'
		});
	});

	it('says why a run was skipped or failed, without the thread id the daemon names', () => {
		const skipped = run({
			result: 'skipped',
			state: null,
			threadId: null,
			reason: 'Its previous run (thr_abcdefghij0123456789) is still going.'
		});
		expect(lastRunLine(skipped, t0 + 5 * 60_000)).toEqual({
			text: 'Skipped 5m ago: Its previous run is still going.',
			tone: 'quiet',
			threadId: null
		});
		const failed = run({ result: 'failed', state: null, threadId: null, reason: 'git said no' });
		expect(lastRunLine(failed, t0)).toMatchObject({
			text: 'Failed to start just now: git said no',
			tone: 'fail'
		});
	});
});

describe('automationGroups', () => {
	it('groups by project, by name, with a broken config saying why', () => {
		const groups = automationGroups(
			[
				automation('nightly', { projectName: 'web', projectId: 'prj_wwwwwwwwwwwwwwwwwwww', nextRunAt: later(5) }),
				automation('daily', { projectName: 'app', schedule: 'daily 09:00' }),
				automation('weekly', { projectName: 'web', projectId: 'prj_wwwwwwwwwwwwwwwwwwww', schedule: null })
			],
			[{ projectId: 'prj_bbbbbbbbbbbbbbbbbbbb', projectName: 'blog', problem: 'bad JSON' }],
			false,
			t0,
			'UTC'
		);
		expect(groups.map((g) => [g.projectName, g.problem, g.rows.map((r) => r.automation.name)])).toEqual([
			['app', null, ['daily']],
			['blog', 'bad JSON', []],
			['web', null, ['nightly', 'weekly']]
		]);
		expect(groups[2]?.rows.map((r) => [r.schedule, r.next])).toEqual([
			['every hour', 'in 5m'],
			['by hand', null]
		]);
	});
});

describe('automationsSummary', () => {
	it('says the soonest run, paused, or by hand', () => {
		const list = [automation('a', { nextRunAt: later(40) }), automation('b', { nextRunAt: later(12) })];
		expect(automationsSummary(list, false, t0)).toBe('next in 12m');
		expect(automationsSummary(list, true, t0)).toBe('paused');
		expect(automationsSummary([automation('c', { schedule: null })], true, t0)).toBe('by hand');
		expect(automationsSummary([automation('c', { enabled: false, nextRunAt: null })], false, t0)).toBe(
			'by hand'
		);
		expect(automationsSummary([], false, t0)).toBeNull();
	});
});

describe('outcomes', () => {
	it('Run now opens the new thread, or says why nothing started', () => {
		expect(runOutcome({ run: run({ state: 'going' }), thread: { id: 'thr_x' } })).toEqual({
			threadId: 'thr_x'
		});
		const skipped = run({ result: 'skipped', reason: 'Its previous run (thr_abc) is waiting on you.' });
		expect(runOutcome({ run: skipped, thread: null })).toEqual({
			message: 'Skipped: Its previous run is waiting on you.'
		});
	});

	it('archiving says what it did and what it kept', () => {
		expect(archiveOutcome({ archived: [1, 2], kept: [] })).toBe('Archived 2 finished runs; branches kept.');
		expect(archiveOutcome({ archived: [], kept: [{ reason: 'Its worktree has uncommitted changes.' }] })).toBe(
			'Nothing archived. Kept 1: Its worktree has uncommitted changes.'
		);
	});
});
