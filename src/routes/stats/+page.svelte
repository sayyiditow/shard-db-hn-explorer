<script lang="ts">
	import QueryPanel from '$lib/components/QueryPanel.svelte';
	import TimingBadge from '$lib/components/TimingBadge.svelte';
	import { absoluteTime, relativeTime } from '$lib/hn/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** Narrow describe-object response into a renderable shape. The wire
	 *  payload has more fields (slot_size, max_value, max_key …) we
	 *  deliberately don't surface — they're server internals, not part
	 *  of the per-table stats story. */
	type FieldDef = { name: string; type: string; size: number };
	type Described = {
		splits: number;
		record_count: number;
		fields: FieldDef[];
		indexes: string[];
	};
	function described(d: unknown): Described | null {
		if (!d || typeof d !== 'object') return null;
		return d as Described;
	}

	// Total of every panel's individual ms, NOT wall-clock. Useful as
	// "sum of shard-db work" but it overstates real latency because
	// panels fire in parallel. The header badge shows max(panel) instead.
	let maxPanelMs = $derived(
		Math.max(
			data.counts.stories.ms,
			data.counts.comments.ms,
			data.counts.users.ms,
			data.topStoryAuthors.ms,
			data.topCommenters.ms,
			data.topUsers.ms,
			data.schema.stories.ms,
			data.schema.comments.ms,
			data.schema.users.ms
		)
	);
</script>

<svelte:head>
	<title>Stats · shard-db HN Explorer</title>
</svelte:head>

<section class="page-header">
	<div>
		<h1>Stats</h1>
		<p class="lede">
			Every panel below is a single round-trip to shard-db. The badge
			next to each title is its actual server-side latency, measured
			by the SvelteKit loader. Click <em>show shard-db query</em> to
			see the JSON we sent.
		</p>
	</div>
	<TimingBadge ms={maxPanelMs} label="slowest panel" />
</section>

<!-- Headline numbers — three bare-integer counts -->
<section class="counts-strip">
	<div class="count-card">
		<div class="count-num">{data.counts.stories.data.toLocaleString()}</div>
		<div class="count-label">stories</div>
		<TimingBadge ms={data.counts.stories.ms} />
	</div>
	<div class="count-card">
		<div class="count-num">{data.counts.comments.data.toLocaleString()}</div>
		<div class="count-label">comments</div>
		<TimingBadge ms={data.counts.comments.ms} />
	</div>
	<div class="count-card">
		<div class="count-num">{data.counts.users.data.toLocaleString()}</div>
		<div class="count-label">users</div>
		<TimingBadge ms={data.counts.users.ms} />
	</div>
	<div class="count-card total">
		<div class="count-num">{data.counts.totalRecords.toLocaleString()}</div>
		<div class="count-label">total records</div>
		<small>across 3 objects</small>
	</div>
</section>

<div class="grid">
	<QueryPanel
		title="Top story authors"
		ms={data.topStoryAuthors.ms}
		query={data.topStoryAuthors.query}
		error={data.topStoryAuthors.error}
	>
		{#if data.topStoryAuthors.data.length === 0}
			<p class="muted">No data.</p>
		{:else}
			<ol class="rank-list">
				{#each data.topStoryAuthors.data as row, i (row.by)}
					<li>
						<span class="rank">{i + 1}</span>
						<a href="/u/{row.by}" class="who">{row.by}</a>
						<span class="meta">
							<strong>{row.stories}</strong> stories
							· <span title="Total score across their stories">{row.total_score} pts</span>
						</span>
					</li>
				{/each}
			</ol>
		{/if}
	</QueryPanel>

	<QueryPanel
		title="Top commenters"
		ms={data.topCommenters.ms}
		query={data.topCommenters.query}
		error={data.topCommenters.error}
	>
		{#if data.topCommenters.data.length === 0}
			<p class="muted">No data.</p>
		{:else}
			<ol class="rank-list">
				{#each data.topCommenters.data as row, i (row.by)}
					<li>
						<span class="rank">{i + 1}</span>
						<a href="/u/{row.by}" class="who">{row.by}</a>
						<span class="meta">
							<strong>{row.comments}</strong> comments
						</span>
					</li>
				{/each}
			</ol>
		{/if}
	</QueryPanel>

	<QueryPanel
		title="Top users by karma"
		ms={data.topUsers.ms}
		query={data.topUsers.query}
		error={data.topUsers.error}
	>
		{#if data.topUsers.data.length === 0}
			<p class="muted">No data.</p>
		{:else}
			<ol class="rank-list">
				{#each data.topUsers.data as u, i (u.key)}
					<li>
						<span class="rank">{i + 1}</span>
						<a href="/u/{u.key}" class="who">{u.key}</a>
						<span class="meta">
							<strong>{u.karma.toLocaleString()}</strong> karma
							{#if u.created}
								· joined <time title={absoluteTime(u.created)}>{relativeTime(u.created)}</time>
							{/if}
						</span>
					</li>
				{/each}
			</ol>
		{/if}
	</QueryPanel>

	{#each [
		{ name: 'stories', panel: data.schema.stories },
		{ name: 'comments', panel: data.schema.comments },
		{ name: 'users', panel: data.schema.users }
	] as { name, panel } (name)}
		{@const d = described(panel.data)}
		<QueryPanel
			title={name}
			ms={panel.ms}
			query={panel.query}
			error={panel.error}
		>
			{#if d}
				{@const idxSet = new Set(d.indexes)}
				<div class="schema-summary">
					<span><strong>{d.record_count.toLocaleString()}</strong> records</span>
					<span>·</span>
					<span><strong>{d.splits}</strong> shards</span>
					<span>·</span>
					<span><strong>{d.indexes.length}</strong> indexes</span>
				</div>
				<table class="field-table">
					<thead>
						<tr>
							<th>field</th>
							<th>type</th>
							<th class="num-col">bytes</th>
							<th>indexed</th>
						</tr>
					</thead>
					<tbody>
						{#each d.fields as f (f.name)}
							<tr>
								<td><code>{f.name}</code></td>
								<td><span class="type">{f.type}</span></td>
								<td class="num-col">{f.size}</td>
								<td>
									{#if idxSet.has(f.name)}
										<span class="idx-yes" title="B+ tree index on this field">●</span>
									{:else}
										<span class="idx-no">—</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
				{#if d.indexes.some((i) => i.includes('+'))}
					<div class="composite-row">
						<span class="composite-label">composite indexes:</span>
						{#each d.indexes.filter((i) => i.includes('+')) as ci (ci)}
							<code class="composite">{ci}</code>
						{/each}
					</div>
				{/if}
			{/if}
		</QueryPanel>
	{/each}
</div>

<p class="footnote">
	Server-side timings only — no client render cost, no network RTT to your
	browser. Sum of all nine queries on this page: <strong>{data.totalMs.toFixed(1)} ms</strong>;
	wall-clock was <strong>{maxPanelMs.toFixed(1)} ms</strong> because they run in parallel.
</p>

<style>
	.page-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--s-4);
		margin-bottom: var(--s-4);
		flex-wrap: wrap;
	}
	.page-header h1 { margin: 0 0 var(--s-2) 0; font-size: 1.5rem; }
	.lede {
		margin: 0;
		color: var(--c-text-muted);
		font-size: 0.92rem;
		line-height: 1.5;
	}
	.lede em { font-style: italic; }

	.counts-strip {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: var(--s-3);
		margin-bottom: var(--s-4);
	}
	@media (min-width: 720px) {
		.counts-strip { grid-template-columns: repeat(4, 1fr); }
	}
	.count-card {
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-md);
		padding: var(--s-3);
		display: flex;
		flex-direction: column;
		gap: var(--s-1);
	}
	.count-card.total {
		background: var(--c-accent-soft);
		border-color: var(--c-accent);
	}
	.count-num {
		font-family: var(--f-mono);
		font-size: 1.6rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.count-label {
		color: var(--c-text-muted);
		font-size: 0.85rem;
		text-transform: lowercase;
	}
	.count-card small {
		color: var(--c-text-faint);
		font-size: 0.72rem;
	}

	.grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--s-4);
	}
	@media (min-width: 760px) {
		.grid { grid-template-columns: 1fr 1fr; }
	}

	.rank-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
	}
	.rank-list li {
		display: grid;
		grid-template-columns: 1.6rem 1fr;
		row-gap: 0.1rem;
		padding: 0.4rem 0;
		border-bottom: 1px solid var(--c-border);
		font-size: 0.88rem;
	}
	.rank-list li:last-child { border-bottom: 0; }
	.rank {
		font-family: var(--f-mono);
		color: var(--c-text-faint);
		font-size: 0.8rem;
		grid-row: 1 / span 2;
		text-align: right;
		padding-right: var(--s-2);
	}
	.who {
		color: var(--c-text);
		font-weight: 500;
	}
	.who:hover { color: var(--c-link); }
	.meta {
		color: var(--c-text-muted);
		font-size: 0.8rem;
		grid-column: 2;
	}
	.meta strong {
		color: var(--c-text);
		font-variant-numeric: tabular-nums;
	}

	.schema-summary {
		display: flex;
		gap: var(--s-2);
		font-size: 0.82rem;
		color: var(--c-text-muted);
		flex-wrap: wrap;
	}
	.schema-summary strong {
		color: var(--c-text);
		font-variant-numeric: tabular-nums;
	}
	.field-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	.field-table th,
	.field-table td {
		text-align: left;
		padding: 0.35rem 0.4rem;
		border-bottom: 1px solid var(--c-border);
	}
	.field-table th {
		color: var(--c-text-faint);
		font-weight: 500;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.field-table tr:last-child td { border-bottom: 0; }
	.field-table code {
		background: transparent;
		padding: 0;
		font-family: var(--f-mono);
		font-size: 0.85rem;
		color: var(--c-text);
	}
	.field-table .type {
		font-family: var(--f-mono);
		font-size: 0.8rem;
		color: var(--c-text-muted);
		padding: 0.1rem 0.4rem;
		background: var(--c-surface-2);
		border-radius: var(--r-sm);
	}
	.field-table .num-col {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--c-text-muted);
	}
	.field-table .idx-yes {
		color: var(--c-good);
		font-size: 0.7rem;
	}
	.field-table .idx-no {
		color: var(--c-text-faint);
	}
	.composite-row {
		display: flex;
		gap: var(--s-2);
		flex-wrap: wrap;
		align-items: center;
		font-size: 0.8rem;
	}
	.composite-label {
		color: var(--c-text-faint);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-size: 0.7rem;
	}
	.composite {
		background: var(--c-surface-2);
		padding: 0.15rem 0.45rem;
		border-radius: var(--r-sm);
		font-family: var(--f-mono);
		font-size: 0.78rem;
		color: var(--c-text);
	}

	.muted { color: var(--c-text-muted); }

	.footnote {
		margin-top: var(--s-5);
		font-size: 0.82rem;
		color: var(--c-text-muted);
		text-align: center;
	}
	.footnote strong {
		color: var(--c-text);
		font-family: var(--f-mono);
	}
</style>
