<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		archiveOutcome,
		automationGroups,
		automationsSummary,
		runOutcome,
		type RunTone
	} from '#lib/automations.ts';
	import { back } from '#lib/nav.ts';
	import { connectionLabel } from '#lib/status.ts';
	import { command, tenzo } from '#lib/tenzo.svelte.ts';

	// Automations (PRODUCT.md §7): a minimal list, the full screen is post-MVP. Each automation
	// its project's config defines, when it runs next and how its last run went, live; Run now
	// starts one and opens its thread. The same layers as Threads: one card tone, clay only for a
	// run that waits on you.
	let now = $state(Date.now());
	const live = $derived(tenzo.state);
	/** The daemon's clock, for counting down to the times it set: this device's may be off. */
	const daemonNow = $derived(now + live.connection.clockOffset);
	const groups = $derived(
		automationGroups(live.automations, live.automationProblems, live.automationsPaused, daemonNow)
	);
	const summary = $derived(automationsSummary(live.automations, live.automationsPaused, daemonNow));
	/** Automations being started, archived, or the switch being flipped: their buttons wait. */
	let busy = $state.raw<ReadonlySet<string>>(new Set());
	/** What the last Run now or archive of an automation said, by key. */
	let notes = $state.raw<ReadonlyMap<string, string>>(new Map());
	/** The automation whose "Archive finished runs" is asking to be confirmed. */
	let confirming = $state<string | null>(null);
	let switchNote = $state<string | null>(null);

	const DOTS: Record<RunTone, string> = {
		clay: 'bg-clay',
		working: 'bg-working',
		done: 'bg-done',
		fail: 'bg-fail',
		quiet: 'bg-fill-strong'
	};

	function setBusy(key: string, on: boolean) {
		const next = new Set(busy);
		if (on) next.add(key);
		else next.delete(key);
		busy = next;
	}

	function note(key: string, text: string | null) {
		const next = new Map(notes);
		if (text === null) next.delete(key);
		else next.set(key, text);
		notes = next;
	}

	async function runNow(key: string, project: string, name: string) {
		if (busy.has(key)) return;
		setBusy(key, true);
		note(key, null);
		try {
			const outcome = runOutcome(await command({ type: 'automation.run', project, name }));
			if ('threadId' in outcome) {
				await goto(`/threads/${outcome.threadId}`);
				return;
			}
			note(key, outcome.message);
		} catch (error) {
			note(key, error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(key, false);
		}
	}

	async function archiveFinished(key: string, project: string, name: string) {
		confirming = null;
		setBusy(key, true);
		note(key, null);
		try {
			note(key, archiveOutcome(await command({ type: 'automation.archiveFinished', project, name })));
		} catch (error) {
			note(key, error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(key, false);
		}
	}

	async function toggle() {
		if (busy.has('switch')) return;
		setBusy('switch', true);
		switchNote = null;
		try {
			await command({ type: 'automation.pause', paused: !live.automationsPaused });
		} catch (error) {
			switchNote = error instanceof Error ? error.message : String(error);
		} finally {
			setBusy('switch', false);
		}
	}

	// Fresh times are counted from now, not from the last tick ("in 5m", not "in 6m").
	$effect(() => {
		void live.automations;
		now = Date.now();
	});

	onMount(() => {
		const tick = setInterval(() => (now = Date.now()), 15_000);
		return () => clearInterval(tick);
	});
</script>

<svelte:head>
	<title>Automations · Tenzo</title>
</svelte:head>

<main class="fixed inset-0 overflow-hidden bg-black text-ink" data-testid="automations-list">
	<div
		class="scroll mx-auto flex h-full w-full max-w-[440px] flex-col overflow-y-auto pt-[calc(env(safe-area-inset-top)+14px)] pb-[calc(env(safe-area-inset-bottom)+40px)] sm:pt-6"
	>
		<header class="mb-[22px] flex items-end justify-between gap-4 px-6">
			<div class="flex min-w-0 flex-col gap-0.5">
				<h1 class="text-[34px] leading-[1.1] font-bold tracking-[-0.02em]">Automations</h1>
				<p class="truncate text-[15px] text-mute" aria-live="polite" data-testid="summary">
					{#if !tenzo.online}
						{connectionLabel(live.connection)}
					{:else if summary}
						{summary.charAt(0).toUpperCase()}{summary.slice(1)}
					{:else if tenzo.seen}
						None yet
					{/if}
				</p>
			</div>
			<button
				type="button"
				aria-label="Close"
				class="opt flex size-11 shrink-0 items-center justify-center rounded-full bg-card text-ink"
				onclick={back}
				data-testid="close"
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
			</button>
		</header>

		<div class="flex flex-col px-5">
			{#if tenzo.seen && groups.length === 0}
				<p class="px-1 text-[17px] text-mute" data-testid="no-automations">
					No automations. A project defines them under <code class="font-mono text-[15px]">automations</code> in
					<code class="font-mono text-[15px]">.tenzo/config.json</code>.
				</p>
			{/if}

			{#if live.automations.length > 0}
				<!-- The off switch, kept in Tenzo's home: while it is on, no schedule starts a run. -->
				<div
					class="mb-[26px] flex min-h-14 items-center gap-3.5 rounded-[20px] bg-card px-[18px] py-2"
					data-testid="switch-row"
				>
					<span class="flex min-w-0 grow flex-col">
						<span>{live.automationsPaused ? 'Schedules paused' : 'Schedules on'}</span>
						<span class="text-[13px] leading-[1.3] text-mute">
							{live.automationsPaused
								? 'Nothing starts by itself. Run now still works.'
								: 'Automations start on their schedules.'}
						</span>
					</span>
					<button
						type="button"
						role="switch"
						aria-checked={!live.automationsPaused}
						aria-label="Schedules"
						disabled={!tenzo.online || busy.has('switch')}
						class={[
							'relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50 motion-reduce:transition-none',
							live.automationsPaused ? 'bg-fill-strong' : 'bg-done'
						]}
						onclick={toggle}
						data-testid="pause"
						data-paused={live.automationsPaused}
					>
						<span
							class={[
								'absolute top-[2px] left-[2px] size-[27px] rounded-full bg-ink shadow-[0_2px_6px_rgba(0,0,0,.35)] transition-transform duration-200 motion-reduce:transition-none',
								!live.automationsPaused && 'translate-x-5'
							]}
						></span>
					</button>
				</div>
				{#if switchNote}
					<p class="-mt-5 mb-[26px] px-1 text-[14px] text-mute" role="status">{switchNote}</p>
				{/if}
			{/if}

			{#each groups as group, g (group.key)}
				<section class={['flex flex-col', g > 0 && 'pt-[26px]']} data-testid="project" data-project={group.projectName}>
					<h2 class="px-1 pb-1.5 text-[13px] font-semibold tracking-[0.06em] text-mute uppercase">
						{group.projectName}
					</h2>
					{#if group.problem}
						<div class="flex gap-3.5 rounded-[20px] bg-card px-[18px] py-3.5" data-testid="problem">
							<span class="mt-[7px] size-2 shrink-0 rounded-full bg-fail"></span>
							<span class="flex min-w-0 flex-col gap-0.5">
								<span>Its config can't be read, so its automations don't run</span>
								<span class="text-[14px] leading-[1.35] break-words text-mute">{group.problem}</span>
							</span>
						</div>
					{/if}
					{#each group.rows as row, i (row.key)}
						{@const a = row.automation}
						{@const top = i === 0 && !group.problem}
						{@const bottom = i === group.rows.length - 1}
						<div class={[!top && 'pt-0.5']}>
							<article
								class={[
									'flex flex-col gap-1 bg-card px-[18px] pt-3 pb-3.5',
									top ? 'rounded-t-[20px]' : 'rounded-t-[6px]',
									bottom ? 'rounded-b-[20px]' : 'rounded-b-[6px]'
								]}
								data-testid="automation"
								data-name={a.name}
							>
								<div class="flex items-baseline gap-3">
									<span class="min-w-0 grow truncate font-semibold" data-testid="automation-name">{a.name}</span>
									{#if row.next}
										<span class="shrink-0 text-[15px] text-mute" data-testid="next">{row.next}</span>
									{/if}
								</div>
								<p class="text-[14px] leading-[1.35] text-mute" data-testid="schedule">
									{row.schedule}{a.model ? ` · ${a.model}` : ''}
								</p>
								{#if a.summary}
									<p class="line-clamp-2 text-[14px] leading-[1.35] text-faint">{a.summary}</p>
								{/if}

								<!-- The last run in a line; its thread a tap away. -->
								{#if row.last.threadId}
									<a
										href={`/threads/${row.last.threadId}`}
										class="opt -mx-1 mt-1 flex min-h-11 items-center gap-2.5 rounded-[12px] px-1"
										data-testid="last-run"
										data-tone={row.last.tone}
									>
										<span class={['size-2 shrink-0 rounded-full', DOTS[row.last.tone]]}></span>
										<span class="min-w-0 grow text-[15px] leading-[1.3] text-ink-soft">{row.last.text}</span>
										<svg class="shrink-0 text-faint" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>
									</a>
								{:else}
									<p
										class="mt-1 flex min-h-11 items-center gap-2.5"
										data-testid="last-run"
										data-tone={row.last.tone}
									>
										<span class={['size-2 shrink-0 rounded-full', DOTS[row.last.tone]]}></span>
										<span class="min-w-0 grow text-[15px] leading-[1.3] text-ink-soft">{row.last.text}</span>
									</p>
								{/if}

								{#if confirming === row.key}
									<div class="mt-1 flex flex-col gap-2.5" data-testid="confirm-archive">
										<p class="text-[15px] leading-[1.35]">
											{#if a.finishedRuns === 1}
												Archive its finished run? Its worktree goes; its branch is kept. Not if it has
												uncommitted changes.
											{:else}
												Archive {a.finishedRuns} finished runs? Their worktrees go; branches are kept. Runs with
												uncommitted changes stay.
											{/if}
										</p>
										<div class="flex gap-2">
											<button
												type="button"
												class="opt min-h-11 rounded-full bg-fill px-4 text-[15px] font-medium"
												onclick={() => archiveFinished(row.key, a.projectId, a.name)}
												data-testid="archive-confirm">Archive</button
											>
											<button
												type="button"
												class="opt min-h-11 rounded-full px-4 text-[15px] text-mute"
												onclick={() => (confirming = null)}
												data-testid="archive-cancel">Cancel</button
											>
										</div>
									</div>
								{:else}
									<div class="mt-1 flex flex-wrap items-center gap-2">
										<button
											type="button"
											class="opt flex min-h-11 items-center gap-2 rounded-full bg-fill pr-4 pl-3.5 text-[15px] font-medium disabled:opacity-50"
											disabled={!tenzo.online || busy.has(row.key)}
											onclick={() => runNow(row.key, a.projectId, a.name)}
											data-testid="run-now"
										>
											<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"></path></svg>
											{busy.has(row.key) ? 'Starting…' : 'Run now'}
										</button>
										{#if a.finishedRuns > 0}
											<button
												type="button"
												class="opt min-h-11 rounded-full px-3 text-[15px] text-mute disabled:opacity-50"
												disabled={!tenzo.online || busy.has(row.key)}
												onclick={() => (confirming = row.key)}
												data-testid="archive-finished"
											>
												{a.finishedRuns === 1 ? 'Archive finished run' : `Archive ${a.finishedRuns} finished runs`}
											</button>
										{/if}
									</div>
								{/if}
								{#if notes.get(row.key)}
									<p class="text-[14px] leading-[1.35] text-mute" role="status" data-testid="note">
										{notes.get(row.key)}
									</p>
								{/if}
							</article>
						</div>
					{/each}
				</section>
			{/each}
		</div>
	</div>
</main>
