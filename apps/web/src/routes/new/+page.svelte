<script module lang="ts">
	/** What was typed and not yet started: closing New thread by mistake loses nothing. */
	let draft = '';
</script>

<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import { back, leave } from '#lib/nav.ts';
	import { chooseProject, rememberedProject, rememberProject } from '#lib/projects.ts';
	import { canDictate, dictate } from '#lib/speech.ts';
	import { connectionLabel } from '#lib/status.ts';
	import { command, tenzo } from '#lib/tenzo.svelte.ts';
	import { type Fit, watchViewport } from '#lib/viewport.ts';

	// New thread: say what you want, pick the project, Start. The thread starts in its own
	// worktree on the Mac and this screen goes back to the Pass.
	let text = $state(draft);
	let picked = $state<string | null>(rememberedProject());
	const project = $derived(chooseProject(tenzo.state.projects, picked));
	let starting = $state(false);
	let error = $state<string | null>(null);
	let stopListening = $state.raw<(() => void) | null>(null);
	let dictation = $state(canDictate());
	let fit = $state.raw<Fit | null>(null);
	let field: HTMLTextAreaElement | undefined = $state();
	let from: string | null = null;

	const ready = $derived(text.trim() !== '' && project !== null && !starting);

	$effect(() => {
		draft = text;
	});

	afterNavigate((navigation) => {
		from = navigation.from?.url.pathname ?? null;
	});

	onMount(() => {
		// Projects added on the Mac since the app connected (`tenzo project add`) show up too.
		if (tenzo.online) command({ type: 'project.list' }).catch(() => {});
		field?.focus();
		return watchViewport((next) => (fit = next));
	});

	onDestroy(() => stopListening?.());

	async function start() {
		const prompt = text.trim();
		if (!ready || !project) return;
		stopListening?.();
		starting = true;
		error = null;
		try {
			await command({ type: 'thread.create', project: project.id, prompt });
			rememberProject(project.id);
			text = '';
			leave(from);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			starting = false;
		}
	}

	function onkeydown(event: KeyboardEvent) {
		// ⌘/Ctrl+Enter starts; Enter alone is a new line in the request.
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void start();
		}
	}

	function toggleMic() {
		if (stopListening) {
			stopListening();
			return;
		}
		const before = text.trim();
		stopListening = dictate(
			(heard) => (text = before ? `${before} ${heard}` : heard),
			() => {
				stopListening = null;
				dictation = canDictate();
			}
		);
	}
</script>

<svelte:head>
	<title>New thread · Tenzo</title>
</svelte:head>

<main
	class={['fixed inset-x-0 flex flex-col overflow-hidden bg-black text-ink', !fit && 'inset-y-0']}
	style:top={fit ? `${fit.top}px` : null}
	style:height={fit ? `${fit.height}px` : null}
	data-testid="new-thread"
>
	<div
		class={[
			'mx-auto flex h-full max-h-[920px] w-full max-w-[440px] flex-col px-6 sm:my-auto',
			fit
				? 'pt-3 pb-3'
				: 'pt-[calc(env(safe-area-inset-top)+14px)] pb-[calc(env(safe-area-inset-bottom)+20px)] sm:pt-6 sm:pb-6'
		]}
	>
		<header class={['flex shrink-0 items-center justify-between gap-3', fit ? 'mb-3' : 'mb-7']}>
			<button
				type="button"
				aria-label="Close"
				class="opt flex size-11 shrink-0 items-center justify-center rounded-full bg-card"
				onclick={() => back(from)}
				data-testid="close"
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
			</button>

			{#if project}
				<!-- The pill is the native picker: a select laid over it, so the phone's own list opens. -->
				<label
					class="relative flex min-h-9 max-w-[60%] items-center gap-2 rounded-full bg-card pr-3.5 pl-3.5 text-[14px] text-mute focus-within:outline-2 focus-within:outline-mute"
				>
					<span class="sr-only">Project</span>
					<span class="truncate font-medium text-ink" data-testid="project">{project.name}</span>
					{#if tenzo.state.projects.length > 1}
						<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>
					{/if}
					<select
						class="absolute inset-0 cursor-pointer appearance-none opacity-0"
						value={project.id}
						onchange={(e) => (picked = e.currentTarget.value)}
						data-testid="project-select"
					>
						{#each tenzo.state.projects as p (p.id)}
							<option value={p.id}>{p.name}</option>
						{/each}
					</select>
				</label>
			{/if}
		</header>

		<label for="ask" class="sr-only">What do you want to do?</label>
		<textarea
			id="ask"
			bind:this={field}
			bind:value={text}
			{onkeydown}
			placeholder="What do you want to do?"
			enterkeyhint="enter"
			class="scroll min-h-0 w-full grow resize-none bg-transparent p-0 text-[28px] leading-[1.25] font-semibold tracking-[-0.02em] outline-none placeholder:text-faint"
			data-testid="prompt"
		></textarea>

		<div class="flex shrink-0 flex-col gap-3 pt-3">
			{#if error}
				<p class="text-[14px] leading-snug text-clay" role="alert" data-testid="error">{error}</p>
			{:else if tenzo.seen && tenzo.state.projects.length === 0}
				<p class="text-[14px] leading-snug text-mute" data-testid="no-projects">
					No projects yet. On the Mac: <code class="text-ink-soft">tenzo project add &lt;path&gt;</code>
				</p>
			{:else if !tenzo.online}
				<p class="text-[14px] text-faint" aria-live="polite">{connectionLabel(tenzo.state.connection)}</p>
			{/if}
			<div class="flex items-center justify-between">
				{#if dictation}
					<button
						type="button"
						aria-label={stopListening ? 'Stop dictating' : 'Dictate'}
						aria-pressed={stopListening !== null}
						class={[
							'opt flex size-16 items-center justify-center rounded-full',
							stopListening
								? 'animate-pulse bg-ink text-black motion-reduce:animate-none'
								: 'bg-card'
						]}
						onclick={toggleMic}
						data-testid="mic"
					>
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><path d="M12 18v3"></path></svg>
					</button>
				{:else}
					<span></span>
				{/if}
				<button
					type="button"
					class={[
						'opt flex min-h-14 items-center gap-2 rounded-full px-[26px] text-[17px] font-semibold transition-colors',
						ready ? 'bg-clay text-on-clay' : 'bg-card text-faint'
					]}
					disabled={!ready}
					onclick={start}
					data-testid="start"
				>
					{starting ? 'Starting…' : 'Start'}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>
				</button>
			</div>
		</div>
	</div>
</main>
