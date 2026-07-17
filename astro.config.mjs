// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	vite: {
		server: {
			proxy: {
				'/admin-api': 'http://127.0.0.1:4322',
			},
		},
	},
});
