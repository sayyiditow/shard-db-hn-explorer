<script lang="ts">
	import { relativeTime, absoluteTime, hnItemUrl } from '$lib/hn/format';
	import { sanitiseHnHtml } from '$lib/hn/sanitize';
	import type { CommentNode } from '$lib/hn/comment-tree';

	interface Props {
		node: CommentNode;
		depth?: number;
	}
	let { node, depth = 0 }: Props = $props();

	let collapsed = $state(false);
	let totalDescendants = $derived(countTree(node));

	function countTree(n: CommentNode): number {
		let total = 0;
		const walk = (c: CommentNode) => {
			total++;
			for (const child of c.children) walk(child);
		};
		walk(n);
		return total - 1; // don't count self
	}

	let safeHtml = $derived(sanitiseHnHtml(node.comment.text));
	let isDead = $derived(node.comment.dead);
	let isDeleted = $derived(node.comment.deleted);
</script>

<article class="comment depth-{Math.min(depth, 10)}" id={`c${node.comment.key}`}>
	<header class="byline">
		<button
			type="button"
			class="toggle"
			aria-label={collapsed ? 'expand' : 'collapse'}
			onclick={() => (collapsed = !collapsed)}
		>[{collapsed ? '+' : '–'}]</button>
		{#if isDeleted}
			<span class="muted">[deleted]</span>
		{:else if isDead}
			<span class="muted">[dead] <a href="/u/{node.comment.by}">{node.comment.by}</a></span>
		{:else}
			<a href="/u/{node.comment.by}" class="author">{node.comment.by}</a>
		{/if}
		<time title={absoluteTime(node.comment.time)}>{relativeTime(node.comment.time)}</time>
		<a class="permalink" href={hnItemUrl(node.comment.key)} target="_blank" rel="noopener" title="View on HN">↗</a>
		{#if collapsed && totalDescendants > 0}
			<span class="hidden-count">({totalDescendants} hidden)</span>
		{/if}
	</header>

	{#if !collapsed}
		{#if isDeleted}
			<div class="body muted">(comment deleted)</div>
		{:else}
			<div class="body">{@html safeHtml}</div>
		{/if}

		{#if node.children.length > 0}
			<div class="children">
				{#each node.children as child (child.comment.key)}
					{#await import('./Comment.svelte') then m}
						<m.default node={child} depth={depth + 1} />
					{/await}
				{/each}
			</div>
		{/if}
	{/if}
</article>

<style>
	.comment {
		padding-left: var(--s-3);
		border-left: 2px solid var(--c-border);
		margin: var(--s-3) 0;
	}
	.comment.depth-0 { padding-left: 0; border-left: 0; }

	.byline {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		font-size: 0.8rem;
		color: var(--c-text-muted);
		flex-wrap: wrap;
	}
	.byline .toggle {
		background: transparent;
		border: 0;
		padding: 0;
		color: var(--c-text-faint);
		font-family: var(--f-mono);
		font-size: 0.78rem;
		cursor: pointer;
	}
	.byline .toggle:hover { color: var(--c-accent); }
	.byline .author {
		color: var(--c-text);
		font-weight: 600;
	}
	.byline time { font-variant-numeric: tabular-nums; }
	.byline .permalink {
		color: var(--c-text-faint);
		text-decoration: none;
		font-size: 0.75rem;
	}
	.byline .permalink:hover { color: var(--c-accent); }
	.byline .hidden-count { color: var(--c-text-faint); font-style: italic; }
	.byline .muted { color: var(--c-text-faint); }

	.body {
		margin: var(--s-2) 0;
		font-size: 0.92rem;
		line-height: 1.55;
		color: var(--c-text);
	}
	.body :global(p) { margin: 0 0 var(--s-2) 0; }
	.body :global(p:last-child) { margin-bottom: 0; }
	.body :global(pre) {
		background: var(--c-surface-2);
		padding: var(--s-2) var(--s-3);
		border-radius: var(--r-sm);
		overflow-x: auto;
		font-size: 0.85rem;
	}
	.body :global(code) { font-family: var(--f-mono); }
	.body :global(i) { color: var(--c-text-muted); }
	.body :global(a) { color: var(--c-link); }

	.children {
		margin-top: var(--s-2);
	}
</style>
