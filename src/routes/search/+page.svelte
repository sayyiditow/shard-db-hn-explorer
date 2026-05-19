<script lang="ts">
	import TimingBadge from '$lib/components/TimingBadge.svelte';
	import { relativeTime, absoluteTime, commentSnippet, domainOf, hnItemUrl, pluralise } from '$lib/hn/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.q ? `${data.q} — search` : 'Search'} · shard-db HN Explorer</title>
</svelte:head>

{#if !data.q}
	<section class="empty">
		<h1>Search Hacker News</h1>
		<p>Type a query in the bar at the top — title for stories, body for comments. Case-insensitive.</p>
		<p class="hint">
			Try: <a href="/search?q=show%20hn">show hn</a>,
			<a href="/search?q=postgres">postgres</a>,
			<a href="/search?q=ai">ai</a>.
		</p>
	</section>
{:else}
	<section class="results-header">
		<h1>Results for <q>{data.q}</q></h1>
		<TimingBadge ms={data.totalMs} label="total" />
	</section>

	<div class="cols">
		<!-- Stories column -->
		<section class="col">
			<header class="col-header">
				<h2>Stories</h2>
				{#if data.stories}
					<span class="meta">
						<span>{pluralise(data.stories.rows.length, 'result')}</span>
						<TimingBadge ms={data.stories.queryMs} />
					</span>
				{/if}
			</header>

			{#if data.stories?.error}
				<p class="error">{data.stories.error}</p>
			{:else if !data.stories || data.stories.rows.length === 0}
				<p class="muted">No stories matched.</p>
			{:else}
				<ol class="story-list">
					{#each data.stories.rows as s (s.key)}
						{@const domain = domainOf(s.url)}
						<li>
							<div class="title">
								{#if s.url}
									<a href={s.url} target="_blank" rel="noopener">{s.title}</a>
								{:else}
									<a href="/item/{s.key}">{s.title}</a>
								{/if}
								{#if domain}<span class="domain">({domain})</span>{/if}
							</div>
							<div class="byline">
								{s.score} points · by <a href="/u/{s.by}">{s.by}</a>
								· <time title={absoluteTime(s.time)}>{relativeTime(s.time)}</time>
								· <a href="/item/{s.key}">{pluralise(s.descendants ?? 0, 'comment')}</a>
							</div>
						</li>
					{/each}
				</ol>
			{/if}
		</section>

		<!-- Comments column -->
		<section class="col">
			<header class="col-header">
				<h2>Comments</h2>
				{#if data.comments}
					<span class="meta">
						<span>{pluralise(data.comments.rows.length, 'result')}</span>
						<TimingBadge ms={data.comments.queryMs} />
					</span>
				{/if}
			</header>

			{#if data.comments?.error}
				<p class="error">{data.comments.error}</p>
			{:else if !data.comments || data.comments.rows.length === 0}
				<p class="muted">No comments matched.</p>
			{:else}
				<ul class="comment-list">
					{#each data.comments.rows as c (c.key)}
						<li>
							<p class="snippet"><a href="/item/{c.story_root}#c{c.key}">{commentSnippet(c.text)}</a></p>
							<div class="byline">
								by <a href="/u/{c.by}">{c.by}</a>
								· <time title={absoluteTime(c.time)}>{relativeTime(c.time)}</time>
								· <a href="/item/{c.story_root}">view thread</a>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
{/if}

<style>
	.empty {
		max-width: 56ch;
		margin: var(--s-6) auto;
		text-align: center;
	}
	.empty h1 { margin-bottom: var(--s-2); }
	.empty p { color: var(--c-text-muted); }
	.empty .hint a { margin-right: var(--s-2); }

	.results-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--s-3);
		flex-wrap: wrap;
		margin-bottom: var(--s-5);
	}
	.results-header h1 {
		font-size: 1.4rem;
		margin: 0;
		font-weight: 600;
	}
	.results-header q::before { content: '"'; color: var(--c-text-muted); }
	.results-header q::after { content: '"'; color: var(--c-text-muted); }

	.cols {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--s-6);
	}
	@media (min-width: 880px) {
		.cols { grid-template-columns: 1fr 1fr; }
	}

	.col-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--s-3);
		margin-bottom: var(--s-3);
		padding-bottom: var(--s-2);
		border-bottom: 1px solid var(--c-border);
	}
	.col-header h2 {
		margin: 0;
		font-size: 1rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--c-text-muted);
		font-weight: 600;
	}
	.col-header .meta {
		display: inline-flex;
		gap: var(--s-2);
		align-items: baseline;
		font-size: 0.8rem;
		color: var(--c-text-muted);
	}

	.story-list, .comment-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--s-4);
	}
	.story-list { counter-reset: storyno; }
	.story-list li { counter-increment: storyno; }

	.title {
		font-size: 0.98rem;
		line-height: 1.35;
	}
	.title a { color: var(--c-text); }
	.title a:hover { color: var(--c-link); }
	.title .domain {
		color: var(--c-text-faint);
		font-size: 0.82rem;
		margin-left: var(--s-1);
	}
	.byline {
		font-size: 0.82rem;
		color: var(--c-text-muted);
		margin-top: 0.15rem;
	}
	.byline a { color: var(--c-text-muted); }
	.byline a:hover { color: var(--c-link); }

	.snippet {
		margin: 0;
		font-size: 0.92rem;
		color: var(--c-text);
		line-height: 1.5;
	}
	.snippet a { color: inherit; }
	.snippet a:hover { color: var(--c-link); }

	.muted { color: var(--c-text-muted); font-size: 0.9rem; }
	.error { color: var(--c-warn); }
</style>
