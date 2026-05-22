<script lang="ts">
	import { page } from '$app/state';
	import ThemeToggle from './ThemeToggle.svelte';

	// Cast — `pathname` is typed against the currently-declared route map
	// in SvelteKit; comparing to routes that don't yet exist as files is
	// rejected by the type-checker. The actual runtime string is fine.
	let path = $derived(page.url.pathname as string);

	// Pre-fill search input with current ?q= when the user is already on /search
	// Pre-fill input on `/` (the unified home/browse/search page).
	// Legacy `/search?q=` URLs still work — that route now redirects
	// to `/?q=` so the input pre-fills there too via SvelteKit's
	// post-redirect URL.
	let initialQ = $derived(path === '/' ? (page.url.searchParams.get('q') ?? '') : '');
	let q = $state('');
	$effect(() => {
		q = initialQ;
	});

	// Trigram is a 3-char window — patterns shorter than 3 chars can't use
	// the trigram index and would force a full-record scan on bio/text.
	// Enforce client-side so the server never sees the unindexed shape;
	// keeps the search bar honest about what shard-db can answer fast.
	const MIN_Q_LEN = 3;
	let qTrim = $derived(q.trim());
	let qTooShort = $derived(qTrim.length > 0 && qTrim.length < MIN_Q_LEN);
	let qOk = $derived(qTrim.length >= MIN_Q_LEN);

	function onSubmit(e: SubmitEvent) {
		if (!qOk) {
			e.preventDefault();
		}
	}
</script>

<header>
	<div class="bar">
		<a class="brand" href="/" aria-label="shard-db HN Explorer home">
			<span class="brand-mark" aria-hidden="true">
				<!-- Same three-shard glyph as favicon — visual continuity between
				     tab icon and in-page brand. -->
				<svg viewBox="0 0 64 64" width="100%" height="100%">
					<rect width="64" height="64" rx="10" fill="#15171a"/>
					<g transform="translate(32 32) rotate(-22)">
						<rect x="-18" y="-13" width="32" height="7" rx="2" fill="#ff6600" opacity="0.45"/>
						<rect x="-18" y="-3"  width="32" height="7" rx="2" fill="#ff6600" opacity="0.75"/>
						<rect x="-18" y="7"   width="32" height="7" rx="2" fill="#ff6600"/>
					</g>
				</svg>
			</span>
			<span class="brand-text">HN Explorer</span>
		</a>

		<form
			class="search"
			class:invalid={qTooShort}
			action="/"
			method="get"
			role="search"
			onsubmit={onSubmit}
		>
			<input
				type="search"
				name="q"
				bind:value={q}
				placeholder="Search stories, jobs, polls, comments, users…"
				autocomplete="off"
				aria-label="Search Hacker News"
				aria-invalid={qTooShort}
				minlength={MIN_Q_LEN}
				required
			/>
			<button
				type="submit"
				aria-label="Search"
				disabled={!qOk}
				title={qTooShort ? `Minimum ${MIN_Q_LEN} characters` : 'Search'}
			>↵</button>
			{#if qTooShort}
				<span class="hint" role="status">≥ {MIN_Q_LEN} chars</span>
			{/if}
		</form>

		<nav>
			<a href="/trending" class:active={path === '/trending'}>Trending</a>
			<a href="/stats" class:active={path === '/stats'}>Stats</a>
			<!-- Jobs nav link removed: /?category=job covers the same
			     experience inside the unified home page. /jobs URL
			     still redirects so deep links don't 404. -->
			<ThemeToggle />
		</nav>
	</div>
</header>

<style>
	header {
		position: sticky;
		top: 0;
		z-index: 10;
		background: var(--c-surface);
		border-bottom: 1px solid var(--c-border);
		backdrop-filter: saturate(180%) blur(4px);
	}
	/* Header inner content aligns with <main> below: centred at
	   --page-max with matching horizontal padding so logo / search /
	   nav sit in the same column as the story list. The header's
	   <header> background still spans full-viewport for the visual
	   "top bar" band; only the inner .bar is constrained. Within
	   the bar, the search input flex-grows to fill the gap between
	   the (left-anchored) logo and the (right-anchored) nav. */
	.bar {
		max-width: var(--page-max);
		margin: 0 auto;
		padding: var(--s-3) var(--s-4);
		display: flex;
		align-items: center;
		gap: var(--s-4);
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		text-decoration: none;
		color: var(--c-text);
		font-weight: 700;
		font-size: 0.95rem;
		flex-shrink: 0;
	}
	.brand:hover { text-decoration: none; }
	.brand-mark {
		display: inline-flex;
		width: 28px;
		height: 28px;
		border-radius: var(--r-sm);
		overflow: hidden;
		flex-shrink: 0;
	}
	.brand-mark svg {
		display: block;
	}
	.brand-text {
		font-size: 0.95rem;
	}
	.search {
		flex: 1;
		display: flex;
		align-items: stretch;
		max-width: 520px;
		border: 1px solid var(--c-border);
		border-radius: var(--r-md);
		background: var(--c-bg);
		overflow: hidden;
	}
	.search:focus-within {
		border-color: var(--c-accent);
		box-shadow: 0 0 0 3px var(--c-accent-soft);
	}
	.search input {
		flex: 1;
		border: 0;
		outline: 0;
		background: transparent;
		padding: 0.45rem 0.7rem;
		font: inherit;
		color: var(--c-text);
	}
	.search button {
		border: 0;
		background: transparent;
		color: var(--c-text-muted);
		padding: 0 0.7rem;
		cursor: pointer;
		font-family: var(--f-mono);
	}
	.search button:hover:not(:disabled) { color: var(--c-accent); }
	.search button:disabled { cursor: not-allowed; opacity: 0.4; }
	/* Trigram is a 3-char window — patterns shorter than 3 chars
	   can't use the index and would force unindexed scans. Dim
	   the border + show a hint when the typed query is below the
	   floor so the visitor understands why submit is disabled. */
	.search.invalid { border-color: var(--c-text-muted); }
	.search .hint {
		align-self: center;
		padding: 0 0.7rem;
		color: var(--c-text-muted);
		font-size: 0.72rem;
		font-family: var(--f-mono);
		white-space: nowrap;
	}
	nav {
		display: flex;
		gap: var(--s-3);
		flex-shrink: 0;
	}
	nav a {
		color: var(--c-text-muted);
		font-size: 0.9rem;
		text-decoration: none;
		padding: 0.25rem 0.1rem;
		border-bottom: 2px solid transparent;
	}
	nav a:hover {
		color: var(--c-text);
		text-decoration: none;
	}
	nav a.active {
		color: var(--c-text);
		border-bottom-color: var(--c-accent);
	}

	@media (max-width: 640px) {
		.brand-text { display: none; }
		.bar { gap: var(--s-2); padding: var(--s-2) var(--s-3); }
		nav { gap: var(--s-2); }
	}
</style>
