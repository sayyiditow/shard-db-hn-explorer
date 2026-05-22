<script lang="ts">
	// Thin top-bar progress indicator shown during any SvelteKit
	// navigation (route change, ?query=... change, etc.). Uses the
	// reactive `navigating` from `$app/state` (Svelte 5 idiom). When a
	// load function is in flight, navigating.from is set; we render
	// the bar then.
	//
	// Visual: a fixed top-anchored 2px line that animates left→right
	// continuously. No actual progress percentage (SvelteKit doesn't
	// expose one for load functions) — just an honest "something is
	// happening" cue, which is what most users need.
	import { navigating } from '$app/state';
</script>

{#if navigating.from}
	<div class="loader-bar" role="progressbar" aria-label="Loading"></div>
{/if}

<style>
	.loader-bar {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 2px;
		background: linear-gradient(
			90deg,
			transparent 0%,
			var(--accent, #ff6600) 50%,
			transparent 100%
		);
		background-size: 40% 100%;
		background-repeat: no-repeat;
		animation: slide 1.1s ease-in-out infinite;
		z-index: 9999;
		pointer-events: none;
	}

	@keyframes slide {
		0%   { background-position: -40% 0; }
		100% { background-position: 140% 0; }
	}

	@media (prefers-reduced-motion: reduce) {
		.loader-bar {
			animation: none;
			background: var(--accent, #ff6600);
			opacity: 0.6;
		}
	}
</style>
