<footer>
	<div class="inner">
		<p>
			A showcase of
			<a href="https://github.com/sayyiditow/shard-db" target="_blank" rel="noopener">shard-db</a>.
			Data from the
			<a href="https://github.com/HackerNews/API" target="_blank" rel="noopener">Hacker News API</a>.
			Refreshed every 5 minutes.
		</p>
		<p class="meta">
			<a href="https://github.com/sayyiditow/shard-db-hn-explorer" target="_blank" rel="noopener">Source</a>
			·
			<a href="/stats">Live DB stats</a>
		</p>
	</div>
</footer>

<style>
	footer {
		border-top: 1px solid var(--c-border);
		margin-top: var(--s-8);
		padding: var(--s-5) var(--s-4);
		background: var(--c-surface);
		color: var(--c-text-muted);
		font-size: 0.85rem;
	}
	.inner {
		max-width: var(--page-max);
		margin: 0 auto;
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--s-3);
	}
	p { margin: 0; }
	.meta a { color: inherit; }
</style>
