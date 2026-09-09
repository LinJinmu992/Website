import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MediaStore, readMediaItemsSync } from '../media-store.mjs';

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

for (const invalid of ['{invalid', '{}', '[{"id":"incomplete"}]']) {
	test(`failed legacy migration remains retryable: ${invalid}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'linjinmu-migration-'));
		const options = { dbPath: join(directory, 'blog.db'), legacyJsonPath: join(directory, 'legacy.json') };
		try {
			await writeFile(options.legacyJsonPath, invalid);
			if (invalid !== '[{"id":"incomplete"}]') assert.throws(() => readMediaItemsSync(options));
			await assert.rejects(MediaStore.open(options));
			await writeFile(options.legacyJsonPath, JSON.stringify([{
				id: 'restored', filename: 'restored.jpg', key: 'photos/restored.jpg',
				url: 'https://example.test/restored.jpg', collection: 'photos',
			}]));
			const store = await MediaStore.open(options);
			try { assert.deepEqual(store.list().map((item) => item.id), ['restored']); }
			finally { store.close(); }
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
}

test('missing legacy files can be restored later and read errors are surfaced', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'linjinmu-migration-'));
	const options = { dbPath: join(directory, 'blog.db'), legacyJsonPath: join(directory, 'legacy.json') };
	try {
		const fresh = await MediaStore.open(options);
		assert.equal(fresh.list().length, 0);
		fresh.close();
		await mkdir(options.legacyJsonPath);
		await assert.rejects(MediaStore.open(options));
		await rm(options.legacyJsonPath, { recursive: true });
		await writeFile(options.legacyJsonPath, '[]');
		const repaired = await MediaStore.open(options);
		assert.ok(repaired.statements.getMeta.get('legacy_json_migrated'));
		repaired.close();
	} finally { await rm(directory, { recursive: true, force: true }); }
});
