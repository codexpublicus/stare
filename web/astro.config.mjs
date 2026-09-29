// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	vite: {
		server: {
			// /about imports the repo-root CHANGELOG.md (?raw); let the dev server
			// read one level above web/.
			fs: { allow: ['..'] },
		},
	},
});
