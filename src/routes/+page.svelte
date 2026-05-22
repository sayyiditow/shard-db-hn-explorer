<script lang="ts">
	import TimingBadge from '$lib/components/TimingBadge.svelte';
	import ShareMenu from '$lib/components/ShareMenu.svelte';
	import { relativeTime, absoluteTime, domainOf, pluralise, commentSnippet } from '$lib/hn/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Category pills — combines type filter with derived HN categories
	// (Ask HN / Show HN are type=story + title starts_with). Order
	// matches Algolia's: All → Stories → Show HN → Ask HN → Polls →
	// Jobs. Discovery flow puts Show/Ask near the top because they're
	// what visitors look for.
	const CATEGORIES = [
		{ value: '',      label: 'All' },
		{ value: 'story', label: 'Stories' },
		{ value: 'show',  label: 'Show HN' },
		{ value: 'ask',   label: 'Ask HN' },
		{ value: 'poll',  label: 'Polls' },
		{ value: 'job',   label: 'Jobs' }
	];
	const SORTS = [
		{ value: 'popularity', label: 'Popularity' },
		{ value: 'hot',        label: 'Hot' },
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
			category: data.category,
			sort: data.sort,
			window: data.window,
			by: data.by,
			...patch
		};
		if (next.q) params.set('q', next.q);
		if (next.category) params.set('category', next.category);
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
		if (data.category) params.set('category', data.category);
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

<!-- Page header — two-column.
       Left: title + result summary
       Right: a single right-rail panel that combines the
       "In the DB" dataset size with this page's timing badge so
       both pieces of stats info sit together instead of fighting
       for visual real-estate. -->
<section class="page-header">
	<div class="header-main">
		<h1>
			{#if data.q}
				Results for <q>{data.q}</q>
			{:else}
				Browse Hacker News
			{/if}
		</h1>
		<p class="subtitle">
			<strong>{data.totalCount.toLocaleString()}</strong> matching
			{data.category === 'job'  ? 'job'  :
			 data.category === 'poll' ? 'poll' :
			 data.category === 'ask'  ? 'Ask HN post' :
			 data.category === 'show' ? 'Show HN post' :
			 'story'}{data.totalCount === 1 ? '' : 's'}
			· page of {data.pageSize}
		</p>
	</div>

	<aside class="header-stats" aria-label="Dataset size + page timing">
		<div class="db-mini">
			<span class="db-mini-label">In the DB</span>
			<span class="db-mini-row">
				<strong>{data.dbStats.stories.toLocaleString()}</strong> stories
			</span>
			<span class="db-mini-row">
				<strong>{data.dbStats.comments.toLocaleString()}</strong> comments
			</span>
			<span class="db-mini-row">
				<strong>{data.dbStats.users.toLocaleString()}</strong> users
			</span>
		</div>
		<TimingBadge ms={data.queryMs} label="page + count" />
	</aside>
</section>

<!-- Filter pills, two-line layout:
       Row 1: Category (the primary "what am I looking at" axis)
       Row 2: Sort + Window combined, separated by a thin divider
     Author filter chip drops in below Row 2 when active. -->
<div class="filter-bar" role="navigation" aria-label="Filters">
	<div class="filter-row">
		<span class="filter-label">Category</span>
		{#each CATEGORIES as c (c.value)}
			<a href={pillHref({ category: c.value })}
			   class:active={(data.category || '') === c.value}
			>{c.label}</a>
		{/each}
	</div>
	<div class="filter-row filter-row-split">
		<span class="filter-label">Sort</span>
		{#each SORTS as s (s.value)}
			<a href={pillHref({ sort: s.value })}
			   class:active={data.sort === s.value}
			>{s.label}</a>
		{/each}
		<span class="filter-divider" aria-hidden="true"></span>
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
		{#if data.q || data.category || data.window !== 'all' || data.by}
			Try widening the filters.
		{/if}
	</p>
{:else}
	<ol class="story-list">
		{#each data.stories as s (s.key)}
			{@const domain = domainOf(s.url)}
			<li class="story">
				<div class="title">
					{#if s.url}
						<a href={s.url} target="_blank" rel="noopener">{s.title}</a>
					{:else}
						<a href="/item/{s.key}">{s.title}</a>
					{/if}
					{#if domain}<span class="domain">({domain})</span>{/if}
				</div>
				{#if s.text && s.text.length > 0}
					<!-- Self-post body preview (Ask HN, Show HN with text,
					     polls, jobs without URL). HN HTML stripped to plain
					     text, truncated to ~220 chars. -->
					<p class="preview">{commentSnippet(s.text, 220)}</p>
				{/if}
				<div class="byline">
					<span class="meta meta-score" title="Points">
						<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
							<path fill="currentColor" d="M8 15l-1-.9C3 10.4 1 8.6 1 6.4 1 4.5 2.4 3 4.3 3c1 0 2.1.5 2.7 1.4C7.6 3.5 8.7 3 9.7 3 11.6 3 13 4.5 13 6.4c0 2.2-2 4-6 7.7L8 15z"/>
						</svg>
						<strong>{s.score}</strong> points
					</span>
					<span class="meta meta-author" title="Author profile">
						<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
							<path fill="currentColor" d="M8 8a3 3 0 100-6 3 3 0 000 6zm0 1c-3 0-6 1.5-6 4v2h12v-2c0-2.5-3-4-6-4z"/>
						</svg>
						by <a href="/u/{s.by}">{s.by}</a>
					</span>
					<span class="meta meta-time" title={absoluteTime(s.time)}>
						<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
							<path fill="none" stroke="currentColor" stroke-width="1.4" d="M8 14A6 6 0 108 2a6 6 0 000 12zM8 4.5V8l2.5 1.5"/>
						</svg>
						<time>{relativeTime(s.time)}</time>
					</span>
					<span class="meta meta-comments" title="Comments">
						<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
							<path fill="currentColor" d="M2 3h12a1 1 0 011 1v7a1 1 0 01-1 1H6l-3 3v-3H2a1 1 0 01-1-1V4a1 1 0 011-1z"/>
						</svg>
						<a href="/item/{s.key}">{s.descendants ?? 0}</a>
					</span>
					{#if s.type !== 'story'}
						<span class="meta type-pill">{s.type}</span>
					{/if}
					<span class="meta meta-share">
						<ShareMenu itemKey={s.key} title={s.title} />
					</span>
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
		gap: var(--s-4);
		justify-content: space-between;
		margin-bottom: var(--s-4);
	}
	.page-header h1 { margin: 0 0 var(--s-2) 0; font-size: 1.6rem; }
	.subtitle { color: var(--c-text-muted); margin: 0; font-size: 0.95rem; }
	.header-main { flex: 1; min-width: 0; }
	.header-stats {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: var(--s-2);
		flex-shrink: 0;
	}
	.db-mini {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.15rem;
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--c-border);
		border-radius: var(--r-md);
		background: var(--c-surface);
		min-width: 9.5rem;
	}
	.db-mini-label {
		color: var(--c-text-muted);
		font-size: 0.68rem;
		font-family: var(--f-mono);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin-bottom: 0.2rem;
	}
	.db-mini-row {
		color: var(--c-text-muted);
		font-size: 0.82rem;
	}
	.db-mini-row strong {
		color: var(--c-text);
		margin-right: 0.3rem;
	}

	.filter-bar {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
		margin-bottom: var(--s-4);
		padding: var(--s-3);
		border: 1px solid var(--c-border);
		border-radius: var(--r-md);
		background: var(--c-surface);
	}
	.filter-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem;
	}
	/* Visual divider between Sort and Window groups inside row 2. */
	.filter-divider {
		display: inline-block;
		width: 1px;
		height: 1.1rem;
		background: var(--c-border);
		margin: 0 0.4rem;
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
	}
	.story {
		padding: var(--s-3) 0;
		border-bottom: 1px solid var(--c-border);
	}
	.story:last-child { border-bottom: 0; }
	.title { font-size: 1.02rem; line-height: 1.4; }
	.title a { color: var(--c-text); text-decoration: none; }
	.title a:hover { color: var(--c-accent); text-decoration: none; }
	.domain {
		color: var(--c-text-muted);
		font-size: 0.85rem;
		margin-left: 0.5rem;
		font-family: var(--f-mono);
	}
	.preview {
		margin: var(--s-2) 0 0 0;
		color: var(--c-text-muted);
		font-size: 0.9rem;
		line-height: 1.5;
		max-width: 80ch;
	}
	.byline {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--s-3);
		margin-top: var(--s-2);
		font-size: 0.82rem;
		color: var(--c-text-muted);
	}
	/* Each meta segment is icon + value. Icons inherit colour from
	   the segment for cheap theming — meta-score icon picks up the
	   accent, others stay muted. */
	.meta {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		white-space: nowrap;
	}
	.meta svg { flex-shrink: 0; vertical-align: middle; }
	.meta a { color: inherit; text-decoration: none; }
	.meta a:hover { color: var(--c-accent); text-decoration: none; }

	.meta-score { color: var(--c-accent); }
	.meta-score strong { font-weight: 700; }
	.meta-author { color: var(--c-text); }
	.meta-author a { color: var(--c-text); }
	.meta-time   { color: var(--c-text-muted); }
	.meta-comments { color: var(--c-text); }

	.type-pill {
		display: inline-block;
		font-size: 0.7rem;
		font-family: var(--f-mono);
		color: var(--c-accent);
		border: 1px solid var(--c-accent);
		border-radius: var(--r-sm);
		padding: 0 0.4rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.meta-share { margin-left: auto; }

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
