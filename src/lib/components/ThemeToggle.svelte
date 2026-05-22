<script lang="ts">
	// Binary theme toggle — light ↔ dark. First load resolves the
	// initial state from localStorage; on a fresh visitor with no
	// stored choice, we follow prefers-color-scheme. After that the
	// toggle is the only source of truth.
	//
	// CSS in tokens.css does the actual switch via `:root[data-theme=…]`.
	// This component only sets / removes the attribute on <html>.
	// SSR-safe: server renders without the attribute, client hydrates
	// from localStorage on mount.
	import { onMount } from 'svelte';

	type Mode = 'light' | 'dark';
	let mode: Mode = $state('dark');

	const STORAGE_KEY = 'hn-explorer-theme';

	function apply(m: Mode) {
		document.documentElement.setAttribute('data-theme', m);
	}

	onMount(() => {
		const stored = localStorage.getItem(STORAGE_KEY) as Mode | null;
		if (stored === 'light' || stored === 'dark') {
			mode = stored;
		} else {
			mode = window.matchMedia('(prefers-color-scheme: light)').matches
				? 'light'
				: 'dark';
		}
		apply(mode);
	});

	function toggle() {
		mode = mode === 'dark' ? 'light' : 'dark';
		try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore quota */ }
		apply(mode);
	}

	const icon = $derived(mode === 'dark' ? '☾' : '☀');
	const label = $derived(mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
</script>

<button
	type="button"
	class="theme-toggle"
	onclick={toggle}
	aria-label={label}
	title={label}
>
	<span aria-hidden="true">{icon}</span>
</button>

<style>
	.theme-toggle {
		background: transparent;
		border: 1px solid var(--c-border);
		color: var(--c-text-muted);
		border-radius: var(--r-md);
		width: 32px;
		height: 32px;
		font-size: 1rem;
		cursor: pointer;
		line-height: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.theme-toggle:hover {
		color: var(--c-accent);
		border-color: var(--c-accent);
	}
</style>
