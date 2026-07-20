import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { ContentGit, runGit } from '../content-git.mjs';

test('pushes complete article snapshots and restores them from a private repository', async (t) => {
	const root = await mkdtemp(resolve(tmpdir(), 'blog-content-git-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const remote = resolve(root, 'remote.git');
	const postsDir = resolve(root, 'posts');
	const worktree = resolve(root, 'content-repository');
	await mkdir(postsDir, { recursive: true });
	await runGit(['init', '--bare', remote], { cwd: root });

	const contentGit = new ContentGit({
		allowLocalRepository: true,
		postsDir,
		config: {
			enabled: true,
			repository: remote,
			branch: 'main',
			sshKeyPath: '',
			authorName: 'Test Author',
			authorEmail: 'test@example.com',
			worktree,
		},
	});

	await writeFile(resolve(postsDir, 'first.md'), '# First\n', 'utf8');
	const firstPush = await contentGit.pushSnapshot('Publish first');
	assert.equal(firstPush.synced, true);
	assert.equal(firstPush.changed, true);
	assert.equal(firstPush.postCount, 1);

	await writeFile(resolve(postsDir, 'second.md'), '# Second\n', 'utf8');
	await rm(resolve(postsDir, 'first.md'));
	const secondPush = await contentGit.pushSnapshot('Replace first with second');
	assert.equal(secondPush.changed, true);
	assert.equal(secondPush.postCount, 1);

	await rm(postsDir, { recursive: true, force: true });
	const restored = await contentGit.restoreSnapshot();
	assert.equal(restored.postCount, 1);
	assert.equal(await readFile(resolve(postsDir, 'second.md'), 'utf8'), '# Second\n');
	await assert.rejects(readFile(resolve(postsDir, 'first.md'), 'utf8'), { code: 'ENOENT' });

	const noChange = await contentGit.pushSnapshot('No changes');
	assert.equal(noChange.synced, true);
	assert.equal(noChange.changed, false);
});
