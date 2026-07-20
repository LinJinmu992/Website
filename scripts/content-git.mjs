import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ContentGit, getContentGitConfig } from '../server/content-git.mjs';

const loadDotEnv = async () => {
	const path = resolve(process.cwd(), '.env');
	let text = '';
	try { text = await readFile(path, 'utf8'); } catch { return; }
	for (const rawLine of text.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const index = line.indexOf('=');
		if (index < 1) continue;
		const key = line.slice(0, index).trim();
		let value = line.slice(index + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
};

await loadDotEnv();
const root = resolve(process.env.BLOG_ROOT ?? process.cwd());
const contentGit = new ContentGit({
	config: getContentGitConfig({ root }),
	postsDir: resolve(root, 'src/content/posts'),
});
const command = process.argv[2] ?? 'status';

if (command === 'status') {
	console.log(JSON.stringify(contentGit.publicStatus(), null, 2));
} else if (command === 'test') {
	console.log(JSON.stringify(await contentGit.testConnection(), null, 2));
} else if (command === 'push') {
	console.log(JSON.stringify(await contentGit.pushSnapshot('Manual blog content sync'), null, 2));
} else if (command === 'pull') {
	console.log(JSON.stringify(await contentGit.restoreSnapshot(), null, 2));
} else {
	throw new Error('用法: npm run content:git -- status|test|push|pull');
}
