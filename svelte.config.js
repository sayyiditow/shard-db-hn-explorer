import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// adapter-node — Hetzner VPS deployment, behind Caddy.
		// Bun runs the built server.js directly via `bun ./build`.
		adapter: adapter()
	}
};

export default config;
