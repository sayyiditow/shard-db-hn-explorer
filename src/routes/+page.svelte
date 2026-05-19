<script lang="ts">
	import TimingBadge from '$lib/components/TimingBadge.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function fmt(n: number): string {
		return n.toLocaleString();
	}
</script>

<svelte:head>
	<title>shard-db HN Explorer — search 41M Hacker News items in ms</title>
	<meta name="description" content="A live explorer for Hacker News built on shard-db. Search, browse threads, profile users, and inspect trends — all in milliseconds." />
</svelte:head>

<section class="hero">
	<h1>Hacker News, queryable in milliseconds.</h1>
	<p class="tagline">
		A live showcase for <a href="https://github.com/sayyiditow/shard-db" target="_blank" rel="noopener">shard-db</a>.
		Search the full HN archive, browse threads, profile users, watch trends — all powered by one binary on one VPS.
	</p>
</section>

<section class="status">
	<header>
		<h2>What's in the DB right now</h2>
		{#if !data.error}
			<TimingBadge ms={data.totalMs} label="3 parallel counts" />
		{/if}
	</header>

	{#if data.error}
		<p class="error">
			<strong>shard-db unreachable:</strong> <code>{data.error}</code><br />
			Make sure the daemon is running: <code>bun run app</code> from the repo root.
		</p>
	{:else}
		<dl>
			<div class="row">
				<dt>Stories</dt>
				<dd>{fmt(data.stories)}</dd>
			</div>
			<div class="row">
				<dt>Comments</dt>
				<dd>{fmt(data.comments)}</dd>
			</div>
			<div class="row">
				<dt>Users</dt>
				<dd>{fmt(data.users)}</dd>
			</div>
		</dl>
	{/if}
</section>

<section class="next">
	<h2>Try it</h2>
	<ul>
		<li>Type a search in the bar above (e.g. <a href="/search?q=show%20hn">show hn</a>, <a href="/search?q=postgres">postgres</a>)</li>
		<li>Open a recent thread from <a href="/trending">/trending</a></li>
		<li>Peek under the hood at <a href="/stats">/stats</a></li>
	</ul>
</section>

<style>
	.hero h1 {
		font-size: clamp(1.6rem, 1.2rem + 1.5vw, 2.2rem);
		line-height: 1.15;
		margin: var(--s-3) 0 var(--s-2) 0;
	}
	.hero .tagline {
		color: var(--c-text-muted);
		font-size: 1.02rem;
		max-width: 60ch;
		margin: 0;
	}
	.status {
		margin-top: var(--s-6);
		padding: var(--s-4) var(--s-5);
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
	}
	.status header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--s-3);
		flex-wrap: wrap;
	}
	.status h2 {
		font-size: 1rem;
		margin: 0;
		color: var(--c-text-muted);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	dl {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		gap: var(--s-3);
		margin: var(--s-4) 0 0 0;
	}
	.row {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	dt {
		font-size: 0.8rem;
		color: var(--c-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	dd {
		margin: 0;
		font-family: var(--f-mono);
		font-size: 1.5rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.next {
		margin-top: var(--s-6);
	}
	.next h2 {
		font-size: 1.05rem;
		margin: 0 0 var(--s-2) 0;
	}
	.next ul {
		margin: 0;
		padding-left: var(--s-5);
	}
	.next li { margin-bottom: 0.35rem; color: var(--c-text-muted); }
	.next li a { color: var(--c-link); }
	.error { color: var(--c-warn); margin: var(--s-3) 0 0 0; }
</style>
