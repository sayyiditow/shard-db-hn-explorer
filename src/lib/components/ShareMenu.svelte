<script lang="ts">
	// Per-story share dropdown — Twitter / Facebook / Email / Copy
	// link. Opens on click, closes on outside-click or Escape.
	// All four targets use the HN canonical item URL
	// (news.ycombinator.com/item?id=NNN) as the share target, not
	// the underlying article URL — the share is for the HN
	// discussion thread, not the linked content.
	//
	// Why client-side <a> targets vs server-side proxy: the share
	// URLs are URL-only intents (no auth, no data exfil). Building
	// them server-side just adds latency for no benefit.
	import { onMount } from 'svelte';

	interface Props {
		itemKey: string;   // HN item id
		title: string;     // story title for share text
	}
	let { itemKey, title }: Props = $props();

	let open = $state(false);
	let menuEl: HTMLDivElement | undefined = $state();

	const hnUrl = $derived(`https://news.ycombinator.com/item?id=${itemKey}`);
	const shareText = $derived(title);

	const twitterUrl = $derived(
		`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(hnUrl)}`
	);
	const facebookUrl = $derived(
		`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(hnUrl)}`
	);
	const emailUrl = $derived(
		`mailto:?subject=${encodeURIComponent(shareText)}&body=${encodeURIComponent(hnUrl)}`
	);

	function toggle(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		open = !open;
	}

	function close() { open = false; }

	async function copyLink(e: MouseEvent) {
		e.preventDefault();
		try {
			await navigator.clipboard.writeText(hnUrl);
		} catch { /* ignore — secure context required */ }
		close();
	}

	// Close on outside click + Escape. onMount so we only bind on the
	// client (DOM not available during SSR).
	onMount(() => {
		function onDocClick(e: MouseEvent) {
			if (open && menuEl && !menuEl.contains(e.target as Node)) close();
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') close();
		}
		document.addEventListener('click', onDocClick);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('click', onDocClick);
			document.removeEventListener('keydown', onKey);
		};
	});
</script>

<div class="share-menu" bind:this={menuEl}>
	<button
		type="button"
		class="share-btn"
		onclick={toggle}
		aria-label="Share"
		aria-expanded={open}
		title="Share"
	>
		<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
			<path fill="currentColor" d="M11.5 2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6zM4.5 6.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6zm7 4.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6zM6.1 7.4l3.8-1.9.5.9-3.8 2zm0 1.2l3.8 2-.5.9-3.8-2z"/>
		</svg>
	</button>

	{#if open}
		<div class="share-popover" role="menu">
			<a href={twitterUrl}  target="_blank" rel="noopener" role="menuitem" onclick={close}>Share on Twitter / X</a>
			<a href={facebookUrl} target="_blank" rel="noopener" role="menuitem" onclick={close}>Share on Facebook</a>
			<a href={emailUrl}    role="menuitem" onclick={close}>Share via Email</a>
			<button type="button" role="menuitem" onclick={copyLink}>Copy link</button>
		</div>
	{/if}
</div>

<style>
	.share-menu {
		position: relative;
		display: inline-flex;
		align-items: center;
	}
	.share-btn {
		background: transparent;
		border: 0;
		color: inherit;
		cursor: pointer;
		padding: 0.1rem 0.25rem;
		display: inline-flex;
		align-items: center;
		opacity: 0.7;
	}
	.share-btn:hover { opacity: 1; color: var(--c-accent); }
	.share-popover {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 0.25rem;
		min-width: 11rem;
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-md);
		box-shadow: 0 8px 24px rgba(0,0,0,0.18);
		display: flex;
		flex-direction: column;
		padding: 0.25rem;
		z-index: 50;
	}
	.share-popover > * {
		display: block;
		padding: 0.45rem 0.7rem;
		font-size: 0.85rem;
		color: var(--c-text);
		text-decoration: none;
		background: transparent;
		border: 0;
		border-radius: var(--r-sm);
		text-align: left;
		cursor: pointer;
		font-family: inherit;
	}
	.share-popover > *:hover {
		background: var(--c-surface-2);
		color: var(--c-accent);
	}
</style>
