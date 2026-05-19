<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status} · shard-db HN Explorer</title>
</svelte:head>

<section class="error">
	<h1>{page.status}</h1>
	<p class="message">{page.error?.message ?? 'Something went wrong.'}</p>

	{#if page.status === 404}
		<p class="hint">
			Try <a href="/">the front page</a>, search for something specific in
			the bar above, or browse <a href="/trending">trending</a>.
		</p>
	{:else if page.status === 500}
		<p class="hint">
			Server hiccup. Check the dev console for details, or try the
			<a href="/">front page</a>.
		</p>
	{/if}
</section>

<style>
	.error {
		max-width: 56ch;
		margin: var(--s-7) auto;
		text-align: center;
	}
	h1 {
		font-family: var(--f-mono);
		font-size: 4rem;
		margin: 0;
		color: var(--c-accent);
	}
	.message {
		font-size: 1.05rem;
		margin: var(--s-3) 0 var(--s-5);
		color: var(--c-text);
	}
	.hint {
		color: var(--c-text-muted);
		font-size: 0.95rem;
	}
</style>
