import adapter from 'svelte-adapter-bun';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// svelte-adapter-bun — Hetzner VPS deployment, behind Caddy.
		// Bun runs the built entry directly via `bun ./build/index.js`.
		adapter: adapter()
	}
};

export default config;
