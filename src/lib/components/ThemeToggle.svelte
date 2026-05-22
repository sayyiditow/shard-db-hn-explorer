<script lang="ts">
	// Manual theme toggle — overrides `prefers-color-scheme`. Three
	// states cycle in order: `auto` (follow system) → `light` → `dark`
	// → `auto` again. Persisted to localStorage so the choice survives
	// page loads.
	//
	// CSS in tokens.css does the actual switch via `:root[data-theme=...]`
	// selectors. This component just sets / removes the attribute on
	// <html>. SSR-safe: server renders without the attribute, client
	// hydrates from localStorage on mount.
	import { onMount } from 'svelte';

	type Mode = 'auto' | 'light' | 'dark';
	let mode: Mode = $state('auto');

	const STORAGE_KEY = 'hn-explorer-theme';
	const ORDER: Mode[] = ['auto', 'light', 'dark'];

	function apply(m: Mode) {
		const root = document.documentElement;
		if (m === 'auto') {
			root.removeAttribute('data-theme');
		} else {
			root.setAttribute('data-theme', m);
		}
	}

	onMount(() => {
		const stored = localStorage.getItem(STORAGE_KEY) as Mode | null;
		if (stored && ORDER.includes(stored)) {
			mode = stored;
			apply(stored);
		}
	});

	function cycle() {
		const idx = ORDER.indexOf(mode);
		mode = ORDER[(idx + 1) % ORDER.length];
		try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore quota */ }
		apply(mode);
	}

	const icon = $derived(mode === 'light' ? '☀' : mode === 'dark' ? '☾' : '◐');
	const label = $derived(
		mode === 'light' ? 'Light theme' :
		mode === 'dark'  ? 'Dark theme'  :
		'Auto theme (follow system)'
	);
</script>

<button
	type="button"
	class="theme-toggle"
	onclick={cycle}
	aria-label={`Theme: ${label}. Click to cycle.`}
	title={`${label} · click to cycle`}
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
