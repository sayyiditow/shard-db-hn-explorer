<script lang="ts">
	import TimingBadge from '$lib/components/TimingBadge.svelte';
	import { relativeTime, absoluteTime, domainOf } from '$lib/hn/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Jobs · shard-db HN Explorer</title>
</svelte:head>

<section class="page-header">
	<h1>Jobs</h1>
	<TimingBadge ms={data.queryMs} label="latest + count" />
</section>

{#if data.error}
	<p class="error">{data.error}</p>
{:else}
	<p class="summary">
		<strong>{data.totalCount.toLocaleString()}</strong>
		job{data.totalCount === 1 ? '' : 's'} in the dataset. Showing
		the most recent <strong>{data.jobs.length}</strong>.
	</p>

	{#if data.jobs.length === 0}
		<p class="muted">No jobs in the dataset.</p>
	{:else}
		<ol class="job-list">
			{#each data.jobs as j, i (j.key)}
				{@const domain = domainOf(j.url)}
				<li>
					<span class="rank">{i + 1}</span>
					<div class="row">
						<div class="title">
							{#if j.url}
								<a href={j.url} target="_blank" rel="noopener">{j.title}</a>
							{:else}
								<a href="/item/{j.key}">{j.title}</a>
							{/if}
							{#if domain}<span class="domain">({domain})</span>{/if}
						</div>
						<div class="byline">
							by <a href="/u/{j.by}">{j.by}</a>
							· <time title={absoluteTime(j.time)}>{relativeTime(j.time)}</time>
						</div>
					</div>
				</li>
			{/each}
		</ol>
	{/if}
{/if}

<style>
	.page-header {
		display: flex;
		align-items: baseline;
		gap: var(--s-3);
		justify-content: space-between;
		margin-bottom: var(--s-3);
	}
	.summary {
		color: var(--c-text-muted);
		margin-bottom: var(--s-4);
	}
	.error {
		color: var(--c-accent);
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-md);
		padding: var(--s-3);
	}
	.muted { color: var(--c-text-muted); }
	.job-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
	}
	.job-list li {
		display: flex;
		gap: var(--s-3);
		align-items: baseline;
	}
	.rank {
		color: var(--c-text-muted);
		font-family: var(--f-mono);
		font-size: 0.85rem;
		flex-shrink: 0;
		min-width: 1.5rem;
		text-align: right;
	}
	.row { flex: 1; min-width: 0; }
	.title {
		font-size: 1rem;
		line-height: 1.35;
	}
	.title a { color: var(--c-text); text-decoration: none; }
	.title a:hover { color: var(--c-accent); text-decoration: none; }
	.domain {
		color: var(--c-text-muted);
		font-size: 0.85rem;
		margin-left: 0.4rem;
	}
	.byline {
		color: var(--c-text-muted);
		font-size: 0.85rem;
		margin-top: 0.15rem;
	}
	.byline a {
		color: var(--c-text-muted);
		text-decoration: none;
	}
	.byline a:hover { color: var(--c-accent); text-decoration: none; }
</style>
