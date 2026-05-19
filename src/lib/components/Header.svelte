<script lang="ts">
	import { page } from '$app/state';

	// Cast — `pathname` is typed against the currently-declared route map
	// in SvelteKit; comparing to routes that don't yet exist as files is
	// rejected by the type-checker. The actual runtime string is fine.
	let path = $derived(page.url.pathname as string);

	// Pre-fill search input with current ?q= when the user is already on /search
	let initialQ = $derived(path === '/search' ? (page.url.searchParams.get('q') ?? '') : '');
	let q = $state('');
	$effect(() => {
		q = initialQ;
	});
</script>

<header>
	<div class="bar">
		<a class="brand" href="/" aria-label="shard-db HN Explorer home">
			<span class="brand-mark">SD</span>
			<span class="brand-text">HN Explorer</span>
		</a>

		<form class="search" action="/search" method="get" role="search">
			<input
				type="search"
				name="q"
				bind:value={q}
				placeholder="Search stories, comments, users…"
				autocomplete="off"
				aria-label="Search Hacker News"
				required
			/>
			<button type="submit" aria-label="Search">↵</button>
		</form>

		<nav>
			<a href="/trending" class:active={path === '/trending'}>Trending</a>
			<a href="/stats" class:active={path === '/stats'}>Stats</a>
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
		display: inline-grid;
		place-items: center;
		width: 28px;
		height: 28px;
		background: var(--c-accent);
		color: white;
		border-radius: var(--r-sm);
		font-family: var(--f-mono);
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: -0.02em;
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
	.search button:hover { color: var(--c-accent); }
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
