import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MediaStore } from '../media-store.mjs';

test('migrates the legacy JSON library and keeps replacements transactional', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'linjinmu-media-'));
	const dbPath = join(directory, 'blog.db');
	const legacyJsonPath = join(directory, 'media-library.json');
	const original = {
		id: 'one', pipelineVersion: 1, collection: 'photos', filename: 'one.jpg', hash: 'abc',
		key: 'photos/one.jpg', url: 'https://img.example/photos/one.jpg', createdAt: '2026-01-01T00:00:00.000Z',
	};
	await writeFile(legacyJsonPath, JSON.stringify([original]));

	const store = await MediaStore.open({ dbPath, legacyJsonPath });
	try {
		assert.equal(store.list('photos').length, 1);
		store.replace([{ ...original, id: 'two', key: 'photos/two.jpg', url: 'https://img.example/photos/two.jpg' }]);
		assert.deepEqual(store.list('photos').map((item) => item.id), ['two']);
		const replacement = { ...original, id: 'three', key: 'photos/three.jpg', url: 'https://img.example/photos/three.jpg' };
		const replaced = store.upsert(replacement);
		assert.deepEqual(replaced.map((item) => item.id), ['two']);
		assert.equal(store.findReusable('abc', 'photos', 1)?.id, 'three');
		store.rollbackUpsert('three', replaced);
		assert.deepEqual(store.list('photos').map((item) => item.id), ['two']);

		const backupPath = join(directory, 'backup', 'blog.db');
		await store.backup(backupPath);
		assert.ok((await readFile(backupPath)).length > 0);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});
