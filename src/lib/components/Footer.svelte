<script lang="ts">
	let { refreshIntervalMinutes }: { refreshIntervalMinutes: number } = $props();
</script>

<footer>
	<div class="inner">
		<p>
			A showcase of
			<a href="https://github.com/sayyiditow/shard-db" target="_blank" rel="noopener">shard-db</a>.
			Data from the
			<a href="https://github.com/HackerNews/API" target="_blank" rel="noopener">Hacker News API</a>.
			Refreshed every {refreshIntervalMinutes} minute{refreshIntervalMinutes === 1 ? '' : 's'}.
		</p>
		<p class="meta">
			<a href="https://github.com/sayyiditow/shard-db-hn-explorer" target="_blank" rel="noopener">Source</a>
			·
			<a href="/stats">Live DB stats</a>
		</p>
	</div>
</footer>

<style>
	/* Background spans edge-to-edge (full-width visual band).
	   Inner content centres at --page-max and adds horizontal
	   padding s-4 — same shape as <main> so the footer text lines
	   up pixel-for-pixel with the body content above. The previous
	   shape (footer padding + .inner with no padding) made the
	   inner span an extra 32px wider than main, which read as a
	   layout misalignment. */
	footer {
		border-top: 1px solid var(--c-border);
		margin-top: var(--s-8);
		padding: var(--s-5) 0;
		background: var(--c-surface);
		color: var(--c-text-muted);
		font-size: 0.85rem;
	}
	.inner {
		max-width: var(--page-max);
		margin: 0 auto;
		padding: 0 var(--s-4);
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--s-3);
	}
	p { margin: 0; }
	.meta a { color: inherit; }
</style>
