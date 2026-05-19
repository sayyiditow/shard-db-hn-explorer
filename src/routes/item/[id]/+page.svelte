<script lang="ts">
	import TimingBadge from '$lib/components/TimingBadge.svelte';
	import Comment from '$lib/components/Comment.svelte';
	import { relativeTime, absoluteTime, domainOf, hnItemUrl, pluralise } from '$lib/hn/format';
	import { sanitiseHnHtml } from '$lib/hn/sanitize';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let storyHasText = $derived(false); // HN ask-style stories store body in `text`, but our schema doesn't keep it — could add later
	let domain = $derived(domainOf(data.story.url));
</script>

<svelte:head>
	<title>{data.story.title} · shard-db HN Explorer</title>
	<meta name="description" content={data.story.title} />
</svelte:head>

<article class="story">
	<header>
		<h1>
			{#if data.story.url}
				<a href={data.story.url} target="_blank" rel="noopener">{data.story.title}</a>
			{:else}
				{data.story.title}
			{/if}
			{#if domain}<span class="domain">({domain})</span>{/if}
		</h1>
		<div class="meta">
			<span>{data.story.score} points</span>
			<span>by <a href="/u/{data.story.by}">{data.story.by}</a></span>
			<time title={absoluteTime(data.story.time)}>{relativeTime(data.story.time)}</time>
			<a href={hnItemUrl(data.story.key)} target="_blank" rel="noopener">↗ HN</a>
		</div>
	</header>
</article>

<section class="comments">
	<header class="section-header">
		<h2>
			{pluralise(data.commentsTotal, 'comment')}
			{#if data.story.descendants && data.commentsTotal < data.story.descendants}
				<span class="of-total">of {data.story.descendants.toLocaleString()}</span>
			{/if}
		</h2>
		<span class="timings">
			<TimingBadge ms={data.storyMs} label="story" />
			<TimingBadge ms={data.commentsMs} label="thread" />
		</span>
	</header>

	{#if data.commentsError}
		<p class="error">{data.commentsError}</p>
	{:else if data.comments.length === 0}
		<p class="muted">No comments yet.</p>
	{:else}
		<div class="thread">
			{#each data.comments as node (node.comment.key)}
				<Comment {node} />
			{/each}
		</div>
		{#if data.hasMore}
			<p class="more-note">
				Showing the first batch of comments — pagination beyond this page is a Phase 3 follow-up.
			</p>
		{/if}
	{/if}
</section>

<style>
	.story header h1 {
		font-size: 1.4rem;
		line-height: 1.3;
		margin: 0 0 var(--s-2) 0;
	}
	.story header h1 a { color: var(--c-text); }
	.story header h1 a:hover { color: var(--c-link); }
	.story header h1 .domain {
		color: var(--c-text-faint);
		font-size: 0.95rem;
		font-weight: 400;
		margin-left: var(--s-1);
	}
	.story .meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-3);
		color: var(--c-text-muted);
		font-size: 0.85rem;
	}
	.story .meta a { color: inherit; }
	.story .meta a:hover { color: var(--c-link); }

	.comments {
		margin-top: var(--s-6);
	}
	.section-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--s-3);
		flex-wrap: wrap;
		margin-bottom: var(--s-4);
		padding-bottom: var(--s-2);
		border-bottom: 1px solid var(--c-border);
	}
	.section-header h2 {
		margin: 0;
		font-size: 1rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--c-text-muted);
		font-weight: 600;
	}
	.section-header .of-total {
		color: var(--c-text-faint);
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
		margin-left: var(--s-2);
	}
	.section-header .timings {
		display: inline-flex;
		gap: var(--s-2);
	}

	.thread > :global(.comment.depth-0) {
		padding: var(--s-3) 0;
		border-top: 1px solid var(--c-border);
		border-left: 0;
		padding-left: 0;
		margin: 0;
	}
	.thread > :global(.comment.depth-0:first-child) {
		border-top: 0;
		padding-top: 0;
	}

	.more-note {
		margin-top: var(--s-5);
		padding: var(--s-3);
		background: var(--c-surface);
		border-radius: var(--r-md);
		font-size: 0.85rem;
		color: var(--c-text-muted);
	}
	.muted { color: var(--c-text-muted); }
	.error { color: var(--c-warn); }
</style>
