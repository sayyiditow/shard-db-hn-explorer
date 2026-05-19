<!--
  Wraps any /stats panel: heading, timing badge, collapsible "show query"
  details (the raw shard-db JSON we sent), an error slot, and the body.
  This is the visual that turns the explorer into a showcase: every panel
  tells the visitor *what* query produced it and *how fast*.
-->
<script lang="ts">
	import TimingBadge from './TimingBadge.svelte';

	interface Props {
		title: string;
		ms: number;
		query: Record<string, unknown>;
		error?: string;
		children?: import('svelte').Snippet;
	}
	let { title, ms, query, error, children }: Props = $props();

	let queryPretty = $derived(JSON.stringify(query, null, 2));
</script>

<section class="panel">
	<header>
		<h2>{title}</h2>
		<TimingBadge {ms} />
	</header>

	<details>
		<summary>show shard-db query</summary>
		<pre class="query"><code>{queryPretty}</code></pre>
	</details>

	{#if error}
		<p class="error">shard-db error: <code>{error}</code></p>
	{:else if children}
		{@render children()}
	{/if}
</section>

<style>
	.panel {
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-md);
		padding: var(--s-4);
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
	}
	header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--s-3);
		flex-wrap: wrap;
	}
	header h2 {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 600;
	}
	details {
		font-size: 0.78rem;
	}
	details summary {
		color: var(--c-text-muted);
		cursor: pointer;
		user-select: none;
		padding: 0.15rem 0;
	}
	details summary:hover { color: var(--c-text); }
	details[open] summary { color: var(--c-text); margin-bottom: var(--s-2); }
	pre.query {
		margin: 0;
		padding: var(--s-3);
		background: var(--c-bg);
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
		overflow-x: auto;
		font-size: 0.78rem;
		line-height: 1.45;
	}
	pre.query code {
		font-family: var(--f-mono);
		background: transparent;
		padding: 0;
	}
	.error {
		color: var(--c-warn);
		font-size: 0.85rem;
		margin: 0;
	}
	.error code {
		background: var(--c-surface-2);
		padding: 0.1rem 0.3rem;
		border-radius: var(--r-sm);
	}
</style>
