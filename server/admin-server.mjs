import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAdminServer } from './admin-app.mjs';

const loadDotEnv = async () => {
	const envPath = resolve(process.cwd(), '.env');
	let text = '';

	try {
		text = await readFile(envPath, 'utf8');
	} catch {
		return;
	}

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();

		if (!line || line.startsWith('#')) continue;

		const index = line.indexOf('=');
		if (index === -1) continue;

		const key = line.slice(0, index).trim();
		let value = line.slice(index + 1).trim();

		if (!key || process.env[key] !== undefined) continue;

		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		process.env[key] = value;
	}
};

await loadDotEnv();
const host = process.env.ADMIN_HOST ?? '127.0.0.1';
const port = Number(process.env.ADMIN_PORT ?? 4322);
const server = await createAdminServer({ root: resolve(process.env.BLOG_ROOT ?? process.cwd()) });
server.listen(port, host, () => {
	console.log(`Admin API listening on http://${host}:${port}`);
});
