<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>shard-db HN Explorer</title>
</svelte:head>

<main>
	<h1>shard-db HN Explorer</h1>
	<p>Hacker News, searchable in milliseconds.</p>

	<section class="status">
		<h2>DB status</h2>
		{#if data.error}
			<p class="error">shard-db unreachable: <code>{data.error}</code></p>
			<p>Make sure shard-db is running: <code>cd ../shard-db && ./shard-db start</code></p>
		{:else}
			<dl>
				<dt>stories</dt><dd>{data.stories.toLocaleString()}</dd>
				<dt>comments</dt><dd>{data.comments.toLocaleString()}</dd>
				<dt>users</dt><dd>{data.users.toLocaleString()}</dd>
			</dl>
			<p class="timing">Total query time: <strong>{data.totalMs.toFixed(2)} ms</strong></p>
		{/if}
	</section>

	<section>
		<h2>Next</h2>
		<p>Search, profiles, threads, trending — see <a href="https://github.com/sayyiditow/shard-db-hn-explorer/blob/main/docs/PLAN.md">docs/PLAN.md</a>.</p>
	</section>
</main>

<style>
	main {
		max-width: 720px;
		margin: 2rem auto;
		padding: 0 1rem;
		font-family: system-ui, sans-serif;
		line-height: 1.5;
	}
	h1 { margin-bottom: 0.25rem; }
	.status {
		margin: 2rem 0;
		padding: 1rem 1.5rem;
		background: #f6f8fa;
		border-radius: 6px;
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.25rem 1rem;
	}
	dt { font-weight: 600; }
	.timing {
		margin-top: 1rem;
		color: #555;
		font-size: 0.9rem;
	}
	.error {
		color: #b00;
	}
	code {
		background: #eee;
		padding: 0.1rem 0.3rem;
		border-radius: 3px;
	}
</style>
