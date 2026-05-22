<script lang="ts">
	import TimingBadge from '$lib/components/TimingBadge.svelte';
	import { relativeTime, absoluteTime, domainOf, pluralise } from '$lib/hn/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const TYPES = [
		{ value: '',      label: 'All' },
		{ value: 'story', label: 'Stories' },
		{ value: 'job',   label: 'Jobs' },
		{ value: 'poll',  label: 'Polls' }
	];
	const SORTS = [
		{ value: 'popularity', label: 'Popularity' },
		{ value: 'newest',     label: 'Newest' }
	];
	const WINDOWS = [
		{ value: 'all', label: 'All time' },
		{ value: '30d', label: 'Past 30 days' },
		{ value: '7d',  label: 'Past 7 days' },
		{ value: '24h', label: 'Past 24h' }
	];

	// Build a "?a=X&b=Y" string from current state + a patch. Drops
	// defaults so the URL stays short for the common cases. Switching
	// any filter resets pagination (we'd lose the cursor anyway).
	function pillHref(patch: Record<string, string>): string {
		const params = new URLSearchParams();
		const next = {
			q: data.q,
			type: data.type,
			sort: data.sort,
			window: data.window,
			by: data.by,
			...patch
		};
		if (next.q) params.set('q', next.q);
		if (next.type) params.set('type', next.type);
		if (next.sort && next.sort !== 'popularity') params.set('sort', next.sort);
		if (next.window && next.window !== 'all') params.set('window', next.window);
		if (next.by) params.set('by', next.by);
		const s = params.toString();
		return s ? `/?${s}` : '/';
	}

	// Pagination URL for `Older →`. Appends the next cursor + bumps
	// ?page= so the visitor sees a stable page counter even though
	// the underlying mechanism is cursor-based (no offset cost).
	// All current filter params carry over.
	let nextHref = $derived.by(() => {
		if (!data.nextCursor) return null;
		const params = new URLSearchParams();
		if (data.q) params.set('q', data.q);
		if (data.type) params.set('type', data.type);
		if (data.sort && data.sort !== 'popularity') params.set('sort', data.sort);
		if (data.window && data.window !== 'all') params.set('window', data.window);
		if (data.by) params.set('by', data.by);
		params.set('after', data.nextCursor);
		params.set('page', String((data.page ?? 1) + 1));
		return `/?${params.toString()}`;
	});

	// Range labels for the pagination footer: "Showing 51-75 of 210,520"
	let rangeStart = $derived(((data.page ?? 1) - 1) * data.pageSize + 1);
	let rangeEnd   = $derived(rangeStart + data.stories.length - 1);
	let totalPages = $derived(Math.max(1, Math.ceil(data.totalCount / data.pageSize)));

	// `Newer ←` is browser-back when we're not on page 1. Cursor
	// pagination is forward-only, so the URL history IS the back
	// stack — easier to use it than to maintain a parallel "back
	// cursor" param.
	function newer(e: MouseEvent) {
		if ((data.page ?? 1) > 1) {
			e.preventDefault();
			history.back();
		}
	}
</script>

<svelte:head>
	<title>shard-db HN Explorer — search Hacker News in milliseconds</title>
	<meta name="description" content="A live explorer for Hacker News built on shard-db. Browse, filter by type, sort, paginate via shard-db cursors — all in milliseconds." />
</svelte:head>

<!-- "What's in the DB right now" — compact strip. Three counts in
     parallel hit kf-header metadata (O(1)), cheap enough to fire on
     every home load. Same numbers visitors used to see in the big
     card on the prior home page, just trimmed so the browse list
     becomes the page's focus. -->
<aside class="db-strip" aria-label="Dataset size">
	<span class="db-strip-label">In the DB</span>
	<span class="stat"><strong>{data.dbStats.stories.toLocaleString()}</strong> stories</span>
	<span class="stat"><strong>{data.dbStats.comments.toLocaleString()}</strong> comments</span>
	<span class="stat"><strong>{data.dbStats.users.toLocaleString()}</strong> users</span>
</aside>

<section class="page-header">
	<div>
		<h1>
			{#if data.q}
				Results for <q>{data.q}</q>
			{:else}
				Browse Hacker News
			{/if}
		</h1>
		<p class="subtitle">
			<strong>{data.totalCount.toLocaleString()}</strong> matching
			{data.type === 'job'  ? 'job'  :
			 data.type === 'poll' ? 'poll' :
			 'story'}{data.totalCount === 1 ? '' : 's'}
			· page of {data.pageSize}
		</p>
	</div>
	<TimingBadge ms={data.queryMs} label="page + count" />
</section>

<!-- Filter pills, Algolia-style. Each pill is a link with the
     relevant param patched on top of the current URL state. -->
<div class="filter-bar" role="navigation" aria-label="Filters">
	<div class="filter-row">
		<span class="filter-label">Type</span>
		{#each TYPES as t (t.value)}
			<a href={pillHref({ type: t.value })}
			   class:active={(data.type || '') === t.value}
			>{t.label}</a>
		{/each}
	</div>
	<div class="filter-row">
		<span class="filter-label">Sort</span>
		{#each SORTS as s (s.value)}
			<a href={pillHref({ sort: s.value })}
			   class:active={data.sort === s.value}
			>{s.label}</a>
		{/each}
	</div>
	<div class="filter-row">
		<span class="filter-label">Window</span>
		{#each WINDOWS as w (w.value)}
			<a href={pillHref({ window: w.value })}
			   class:active={data.window === w.value}
			>{w.label}</a>
		{/each}
	</div>
	{#if data.by}
		<div class="filter-row author-filter">
			<span class="filter-label">By</span>
			<span class="author-pill">
				<a href="/u/{data.by}">{data.by}</a>
				<a href={pillHref({ by: '' })} class="clear" title="Clear author filter">×</a>
			</span>
		</div>
	{/if}
</div>

{#if data.error}
	<p class="error">{data.error}</p>
{:else if data.stories.length === 0}
	<p class="muted empty-msg">
		No results.
		{#if data.q || data.type || data.window !== 'all' || data.by}
			Try widening the filters.
		{/if}
	</p>
{:else}
	<ol class="story-list">
		{#each data.stories as s (s.key)}
			{@const domain = domainOf(s.url)}
			<li>
				<div class="row">
					<div class="title">
						{#if s.url}
							<a href={s.url} target="_blank" rel="noopener">{s.title}</a>
						{:else}
							<a href="/item/{s.key}">{s.title}</a>
						{/if}
						{#if domain}<span class="domain">({domain})</span>{/if}
					</div>
					<div class="byline">
						<span class="score">{s.score} points</span>
						· by <a href={pillHref({ by: s.by })}>{s.by}</a>
						· <time title={absoluteTime(s.time)}>{relativeTime(s.time)}</time>
						· <a href="/item/{s.key}">{pluralise(s.descendants ?? 0, 'comment')}</a>
						{#if s.type !== 'story'}
							· <span class="type-pill">{s.type}</span>
						{/if}
					</div>
				</div>
			</li>
		{/each}
	</ol>

	<!-- Cursor-based pagination footer. Range labels make it clear
	     where the visitor is; Newer/Older buttons mirror the standard
	     numbered pagination feel but use shard-db's forward cursor
	     under the hood (so deep pages stay O(limit), not O(offset)).
	     `Newer ←` uses history.back() because URL history IS the
	     back-cursor stack — cleaner than threading a parallel param. -->
	<nav class="pagination" aria-label="Pagination">
		<a
			href="/"
			class="page-link page-prev"
			class:disabled={(data.page ?? 1) <= 1}
			aria-disabled={(data.page ?? 1) <= 1}
			onclick={newer}
		>← Newer</a>

		<div class="page-info">
			<div class="page-num">Page {data.page ?? 1}<span class="of">of {totalPages.toLocaleString()}</span></div>
			<div class="page-range">{rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {data.totalCount.toLocaleString()}</div>
		</div>

		{#if nextHref}
			<a href={nextHref} class="page-link page-next">Older →</a>
		{:else}
			<span class="page-link page-end" aria-disabled="true">End</span>
		{/if}
	</nav>
{/if}

<style>
	.page-header {
		display: flex;
		align-items: flex-start;
		gap: var(--s-3);
		justify-content: space-between;
		margin-bottom: var(--s-3);
	}
	.page-header h1 { margin: 0 0 var(--s-2) 0; font-size: 1.6rem; }
	.subtitle { color: var(--c-text-muted); margin: 0; font-size: 0.95rem; }

	.filter-bar {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2) var(--s-3);
		margin-bottom: var(--s-4);
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--c-border);
		border-radius: var(--r-md);
		background: var(--c-surface);
	}
	.filter-row {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.filter-label {
		color: var(--c-text-muted);
		font-size: 0.78rem;
		font-family: var(--f-mono);
		margin-right: 0.2rem;
	}
	.filter-bar a {
		color: var(--c-text-muted);
		font-size: 0.85rem;
		text-decoration: none;
		padding: 0.2rem 0.6rem;
		border-radius: var(--r-sm);
		border: 1px solid transparent;
	}
	.filter-bar a:hover {
		color: var(--c-text);
		border-color: var(--c-border);
		text-decoration: none;
	}
	.filter-bar a.active {
		color: var(--c-text);
		background: var(--c-bg);
		border-color: var(--c-border);
		font-weight: 600;
	}
	.author-filter .author-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		background: var(--c-bg);
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
		padding: 0.1rem 0.4rem;
	}
	.author-pill .clear { color: var(--c-text-muted); }
	.author-pill .clear:hover { color: var(--c-accent); }

	.error {
		color: var(--c-accent);
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-md);
		padding: var(--s-3);
	}
	.muted { color: var(--c-text-muted); }
	.empty-msg { margin-top: var(--s-3); }

	.story-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
	}
	.row { flex: 1; min-width: 0; }
	.title { font-size: 1rem; line-height: 1.35; }
	.title a { color: var(--c-text); text-decoration: none; }
	.title a:hover { color: var(--c-accent); text-decoration: none; }
	.domain { color: var(--c-text-muted); font-size: 0.85rem; margin-left: 0.4rem; }
	.byline {
		color: var(--c-text-muted);
		font-size: 0.85rem;
		margin-top: 0.15rem;
	}
	.byline a { color: var(--c-text-muted); text-decoration: none; }
	.byline a:hover { color: var(--c-accent); text-decoration: none; }
	.score { color: var(--c-text); font-weight: 600; }
	.type-pill {
		display: inline-block;
		font-size: 0.7rem;
		font-family: var(--f-mono);
		color: var(--c-accent);
		border: 1px solid var(--c-accent);
		border-radius: var(--r-sm);
		padding: 0 0.35rem;
	}

	.db-strip {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--s-3);
		padding: var(--s-2) var(--s-3);
		margin-bottom: var(--s-3);
		border: 1px solid var(--c-border);
		border-radius: var(--r-md);
		background: var(--c-surface);
		font-size: 0.9rem;
	}
	.db-strip-label {
		color: var(--c-text-muted);
		font-size: 0.75rem;
		font-family: var(--f-mono);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.db-strip .stat { color: var(--c-text-muted); }
	.db-strip .stat strong { color: var(--c-text); margin-right: 0.25rem; }

	.pagination {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-3);
		margin-top: var(--s-5);
		padding-top: var(--s-3);
		border-top: 1px solid var(--c-border);
	}
	.page-link {
		padding: 0.4rem 0.9rem;
		border: 1px solid var(--c-border);
		border-radius: var(--r-md);
		color: var(--c-text);
		text-decoration: none;
		font-family: var(--f-mono);
		font-size: 0.9rem;
		min-width: 5rem;
		text-align: center;
	}
	.page-link:hover:not(.disabled):not(.page-end) {
		border-color: var(--c-accent);
		color: var(--c-accent);
		text-decoration: none;
	}
	.page-link.disabled,
	.page-link.page-end {
		color: var(--c-text-muted);
		cursor: not-allowed;
		opacity: 0.5;
		pointer-events: none;
	}
	.page-info {
		text-align: center;
		flex: 1;
		min-width: 0;
	}
	.page-num {
		font-family: var(--f-mono);
		color: var(--c-text);
		font-size: 0.9rem;
	}
	.page-num .of {
		color: var(--c-text-muted);
		margin-left: 0.4rem;
		font-size: 0.85rem;
	}
	.page-range {
		color: var(--c-text-muted);
		font-size: 0.78rem;
		margin-top: 0.15rem;
	}
	@media (max-width: 640px) {
		.page-link { min-width: 3.5rem; padding: 0.4rem 0.5rem; }
		.page-num .of { display: none; }
	}
</style>
