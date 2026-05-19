<script lang="ts">
	import TimingBadge from '$lib/components/TimingBadge.svelte';
	import { relativeTime, absoluteTime, domainOf, pluralise } from '$lib/hn/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const windows = [
		{ value: '1h',  label: 'Past hour' },
		{ value: '24h', label: 'Past 24 hours' },
		{ value: '7d',  label: 'Past 7 days' },
		{ value: 'all', label: 'All time' }
	] as const;
</script>

<svelte:head>
	<title>Trending · shard-db HN Explorer</title>
</svelte:head>

<section class="page-header">
	<h1>Trending</h1>
	<TimingBadge ms={data.queryMs} label="top + count" />
</section>

<div class="window-tabs" role="tablist" aria-label="Time window">
	{#each windows as w (w.value)}
		<a
			href={`/trending?window=${w.value}`}
			role="tab"
			aria-selected={data.window === w.value}
			class:active={data.window === w.value}
		>
			{w.label}
		</a>
	{/each}
</div>

{#if data.error}
	<p class="error">{data.error}</p>
{:else}
	<p class="summary">
		<strong>{data.totalCount.toLocaleString()}</strong>
		{pluralise(data.totalCount, 'story', 'stories').split(' ')[1]} matched
		{#if data.since > 0}
			since <time title={absoluteTime(data.since)}>{relativeTime(data.since)}</time>.
		{:else}
			across the entire dataset.
		{/if}
	</p>

	<div class="layout">
		<!-- Top stories table -->
		<section class="col main">
			<h2 class="col-heading">Top by score</h2>
			{#if data.stories.length === 0}
				<p class="muted">No stories in this window.</p>
			{:else}
				<ol class="story-list">
					{#each data.stories as s, i (s.key)}
						{@const domain = domainOf(s.url)}
						<li>
							<span class="rank">{i + 1}</span>
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
									<span class="score">{s.score}</span>
									· by <a href="/u/{s.by}">{s.by}</a>
									· <time title={absoluteTime(s.time)}>{relativeTime(s.time)}</time>
									· <a href="/item/{s.key}">{pluralise(s.descendants ?? 0, 'comment')}</a>
								</div>
							</div>
						</li>
					{/each}
				</ol>
			{/if}
		</section>

		<!-- Domain ranking sidebar -->
		<aside class="col side">
			<h2 class="col-heading">Top domains</h2>
			{#if data.domains.length === 0}
				<p class="muted">No domains.</p>
			{:else}
				<ol class="domain-list">
					{#each data.domains as d (d.domain)}
						<li>
							<span class="domain-name">{d.domain}</span>
							<span class="domain-meta">
								<span title="Total score across stories from this domain">{d.totalScore}</span>
								·
								<span title="Story count">×{d.count}</span>
							</span>
						</li>
					{/each}
				</ol>
			{/if}
			<p class="aside-note">
				Ranked by total score across the top-{data.stories.length} stories
				in this window.
			</p>
		</aside>
	</div>
{/if}

<style>
	.page-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--s-3);
		flex-wrap: wrap;
		margin-bottom: var(--s-3);
	}
	.page-header h1 { margin: 0; font-size: 1.5rem; }

	.window-tabs {
		display: inline-flex;
		gap: var(--s-1);
		padding: 0.2rem;
		background: var(--c-surface);
		border-radius: var(--r-md);
		border: 1px solid var(--c-border);
		margin-bottom: var(--s-4);
		flex-wrap: wrap;
	}
	.window-tabs a {
		padding: 0.3rem 0.7rem;
		border-radius: var(--r-sm);
		color: var(--c-text-muted);
		font-size: 0.85rem;
		text-decoration: none;
	}
	.window-tabs a:hover { color: var(--c-text); }
	.window-tabs a.active {
		background: var(--c-bg);
		color: var(--c-text);
		font-weight: 600;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
	}

	.summary {
		color: var(--c-text-muted);
		font-size: 0.9rem;
		margin: 0 0 var(--s-4) 0;
	}
	.summary strong { color: var(--c-text); font-family: var(--f-mono); }

	.layout {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--s-5);
	}
	@media (min-width: 760px) {
		.layout { grid-template-columns: 1.7fr 1fr; }
	}

	.col-heading {
		margin: 0 0 var(--s-3) 0;
		font-size: 0.85rem;
		color: var(--c-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		font-weight: 600;
		padding-bottom: var(--s-2);
		border-bottom: 1px solid var(--c-border);
	}

	.story-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
	}
	.story-list li {
		display: grid;
		grid-template-columns: 2rem 1fr;
		gap: var(--s-2);
		padding: var(--s-3) 0;
		border-bottom: 1px solid var(--c-border);
	}
	.story-list li:last-child { border-bottom: 0; }
	.rank {
		font-family: var(--f-mono);
		font-size: 0.85rem;
		color: var(--c-text-faint);
		text-align: right;
		padding-top: 0.15rem;
	}
	.title { font-size: 0.95rem; line-height: 1.35; }
	.title a { color: var(--c-text); }
	.title a:hover { color: var(--c-link); }
	.title .domain { color: var(--c-text-faint); font-size: 0.82rem; margin-left: var(--s-1); }
	.byline {
		font-size: 0.8rem;
		color: var(--c-text-muted);
		margin-top: 0.15rem;
	}
	.byline a { color: var(--c-text-muted); }
	.byline a:hover { color: var(--c-link); }
	.byline .score { color: var(--c-accent); font-weight: 600; }

	.domain-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
	}
	.domain-list li {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		padding: 0.4rem 0;
		border-bottom: 1px solid var(--c-border);
		font-size: 0.88rem;
	}
	.domain-list li:last-child { border-bottom: 0; }
	.domain-name { color: var(--c-text); font-family: var(--f-mono); font-size: 0.85rem; }
	.domain-meta { color: var(--c-text-muted); font-size: 0.8rem; font-variant-numeric: tabular-nums; }
	.aside-note {
		margin-top: var(--s-3);
		font-size: 0.75rem;
		color: var(--c-text-faint);
		line-height: 1.4;
	}

	.muted { color: var(--c-text-muted); }
	.error { color: var(--c-warn); }
</style>
