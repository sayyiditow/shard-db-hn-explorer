<script lang="ts">
	import TimingBadge from '$lib/components/TimingBadge.svelte';
	import { relativeTime, absoluteTime, commentSnippet, domainOf, hnItemUrl, hnUserUrl, pluralise } from '$lib/hn/format';
	import { sanitiseHnHtml } from '$lib/hn/sanitize';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let accountAge = $derived(
		data.user?.created
			? relativeTime(data.user.created)
			: null
	);

	let createdDate = $derived(
		data.user?.created
			? new Date(data.user.created).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
			: null
	);

	type Tab = 'stories' | 'comments';
	let activeTab = $derived<Tab>(
		(page.url.searchParams.get('tab') as Tab) ?? (data.stories.length > 0 ? 'stories' : 'comments')
	);

	function switchTab(tab: Tab) {
		const url = new URL(page.url);
		const defaultTab: Tab = data.stories.length > 0 ? 'stories' : 'comments';
		if (tab === defaultTab) {
			url.searchParams.delete('tab');
		} else {
			url.searchParams.set('tab', tab);
		}
		goto(url, { replaceState: true, noScroll: true, keepFocus: true });
	}
</script>

<svelte:head>
	<title>{data.username} · shard-db HN Explorer</title>
</svelte:head>

<section class="profile">
	<header class="profile-header">
		<h1>{data.username}</h1>
		<div class="header-meta">
			<a href={hnUserUrl(data.username)} target="_blank" rel="noopener">↗ HN profile</a>
			<TimingBadge ms={data.totalMs} label="full profile" />
		</div>
	</header>

	{#if data.user}
		<dl class="stats">
			<div>
				<dt>Karma</dt>
				<dd>{data.user.karma.toLocaleString()}</dd>
			</div>
			<div>
				<dt>Created</dt>
				<dd>{createdDate} <span class="age">({accountAge})</span></dd>
			</div>
			<div>
				<dt>Submissions</dt>
				<dd>{data.user.submitted_count.toLocaleString()}</dd>
			</div>
		</dl>

		{#if data.user.about}
			<div class="about">{@html sanitiseHnHtml(data.user.about)}</div>
		{/if}
	{:else}
		<p class="muted">
			No user record in our sample, but {data.username} has activity below
			(stories or comments). Likely we have partial data — the full bulk-load
			will fill profiles in.
		</p>
	{/if}
</section>

<div class="activity">
	<div class="tab-bar" role="tablist" aria-label="Activity">
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'stories'}
			class:active={activeTab === 'stories'}
			class:empty={data.stories.length === 0}
			onclick={() => switchTab('stories')}
		>
			Submissions
			<span class="count">{data.stories.length}</span>
		</button>
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'comments'}
			class:active={activeTab === 'comments'}
			class:empty={data.comments.length === 0}
			onclick={() => switchTab('comments')}
		>
			Comments
			<span class="count">{data.comments.length}</span>
		</button>
	</div>

	{#if activeTab === 'stories'}
		<section role="tabpanel">
			{#if data.storiesError}
				<p class="error">{data.storiesError}</p>
			{:else if data.stories.length === 0}
				<p class="muted">{data.username} hasn't submitted any stories in our sample.</p>
			{:else}
				<ol class="story-list">
					{#each data.stories as s (s.key)}
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
								<span class="score">{s.score}</span> points
								· <time title={absoluteTime(s.time)}>{relativeTime(s.time)}</time>
								· <a href="/item/{s.key}">{pluralise(s.descendants ?? 0, 'comment')}</a>
							</div>
						</li>
					{/each}
				</ol>
			{/if}
		</section>
	{/if}

	{#if activeTab === 'comments'}
		<section role="tabpanel">
			{#if data.commentsError}
				<p class="error">{data.commentsError}</p>
			{:else if data.comments.length === 0}
				<p class="muted">{data.username} hasn't made any comments in our sample.</p>
			{:else}
				<ul class="comment-list">
					{#each data.comments as c (c.key)}
						<li>
							<p class="snippet">
								<a href="/item/{c.story_root}#c{c.key}">{commentSnippet(c.text)}</a>
							</p>
							<div class="byline">
								<time title={absoluteTime(c.time)}>{relativeTime(c.time)}</time>
								· <a href="/item/{c.story_root}">view thread</a>
								· <a href={hnItemUrl(c.key)} target="_blank" rel="noopener">↗</a>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</div>

<style>
	.profile {
		padding-bottom: var(--s-5);
		border-bottom: 1px solid var(--c-border);
	}
	.profile-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: var(--s-3);
	}
	.profile-header h1 {
		margin: 0;
		font-size: 1.7rem;
		font-family: var(--f-mono);
	}
	.header-meta {
		display: inline-flex;
		gap: var(--s-3);
		align-items: baseline;
		color: var(--c-text-muted);
		font-size: 0.85rem;
	}
	.header-meta a { color: inherit; }
	.header-meta a:hover { color: var(--c-link); }

	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: var(--s-3);
		margin: var(--s-4) 0 var(--s-3) 0;
	}
	.stats > div { display: flex; flex-direction: column; gap: 0.1rem; }
	.stats dt {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--c-text-muted);
	}
	.stats dd {
		margin: 0;
		font-family: var(--f-mono);
		font-size: 1.2rem;
		font-weight: 600;
	}
	.stats .age {
		font-weight: 400;
		font-size: 0.85rem;
		color: var(--c-text-muted);
	}

	.about {
		margin-top: var(--s-3);
		padding: var(--s-3) var(--s-4);
		background: var(--c-surface);
		border-left: 3px solid var(--c-accent);
		border-radius: var(--r-sm);
		font-size: 0.9rem;
		color: var(--c-text);
	}
	.about :global(a) { color: var(--c-link); }

	.activity {
		margin-top: var(--s-5);
	}
	.tab-bar {
		display: flex;
		gap: var(--s-1);
		padding: 0.2rem;
		background: var(--c-surface);
		border-radius: var(--r-md);
		border: 1px solid var(--c-border);
		margin-bottom: var(--s-4);
	}
	.tab-bar button {
		flex: 1;
		padding: 0.4rem 0.8rem;
		border: 0;
		border-radius: var(--r-sm);
		background: transparent;
		color: var(--c-text-muted);
		font: inherit;
		font-size: 0.9rem;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
	}
	.tab-bar button:hover { color: var(--c-text); }
	.tab-bar button.active {
		background: var(--c-bg);
		color: var(--c-text);
		font-weight: 600;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
	}
	.tab-bar button.empty { opacity: 0.5; }
	.tab-bar .count {
		font-family: var(--f-mono);
		font-size: 0.78rem;
		color: var(--c-text-faint);
	}

	.story-list, .comment-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--s-4);
	}
	.title { font-size: 0.95rem; line-height: 1.35; }
	.title a { color: var(--c-text); }
	.title a:hover { color: var(--c-link); }
	.title .domain { color: var(--c-text-faint); font-size: 0.82rem; margin-left: var(--s-1); }
	.byline {
		font-size: 0.8rem;
		color: var(--c-text-muted);
		margin-top: 0.15rem;
	}
	.byline a { color: var(--c-text-muted); }
	.byline a:hover { color: var(--c-link); }
	.byline .score { color: var(--c-accent); font-weight: 600; }
	.snippet { margin: 0; font-size: 0.9rem; line-height: 1.5; }
	.snippet a { color: inherit; }
	.snippet a:hover { color: var(--c-link); }

	.muted { color: var(--c-text-muted); font-size: 0.9rem; }
	.error { color: var(--c-warn); }
</style>
