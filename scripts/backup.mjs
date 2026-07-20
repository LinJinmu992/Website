import { readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { MediaStore } from '../server/media-store.mjs';

const root = resolve(import.meta.dirname, '..');

const loadDotEnv = async () => {
	let text = '';
	try {
		text = await readFile(resolve(root, '.env'), 'utf8');
	} catch {
		return;
	}

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const separator = line.indexOf('=');
		if (separator < 1) continue;
		const key = line.slice(0, separator).trim();
		let value = line.slice(separator + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
};

const removeExpiredBackups = async (backupRoot, currentName) => {
	const retentionDays = Math.max(1, Number.parseInt(process.env.BLOG_BACKUP_RETENTION_DAYS ?? '14', 10) || 14);
	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
		if (!entry.isFile() || entry.name === currentName) continue;
		const match = /^blog-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.db$/.exec(entry.name);
		if (!match) continue;
		const created = Date.parse(match[1].replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z'));
		if (Number.isFinite(created) && created < cutoff) {
			await rm(resolve(backupRoot, entry.name), { force: true });
		}
	}
};

await loadDotEnv();

const backupRoot = resolve(process.env.BLOG_BACKUP_DIR ?? resolve(root, 'server/backups'));
const timestamp = new Date().toISOString().replaceAll(':', '-').replace('.', '-');
const filename = `blog-${timestamp}.db`;
const destination = resolve(backupRoot, filename);
const store = await MediaStore.open({
	dbPath: resolve(root, 'server/data/blog.db'),
	legacyJsonPath: resolve(root, 'server/data/media-library.json'),
});

try {
	await store.backup(destination);
	await removeExpiredBackups(backupRoot, filename);
	console.log(`SQLite backup completed: ${destination}`);
} finally {
	store.close();
}
