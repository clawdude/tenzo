/// <reference types="vitest/config" />
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// In dev the page comes from Vite, so Vite forwards the daemon's routes: the client always uses
// same-origin `/ws` and `/health`, exactly as when the daemon serves the build.
const daemon = `127.0.0.1:${process.env.TENZO_PORT || 4780}`;

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// A static SPA the daemon serves; every route falls back to index.html.
			adapter: adapter({ fallback: 'index.html' })
		})
	],
	server: {
		proxy: {
			'/health': `http://${daemon}`,
			'/ws': { target: `ws://${daemon}`, ws: true },
			// Screenshots. Threads' live apps are on the daemon's live port, linked directly.
			'/api/attachments': `http://${daemon}`
		}
	},
	test: {
		include: ['src/**/*.test.ts']
	}
});
