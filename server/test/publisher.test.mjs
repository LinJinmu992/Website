import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createPublisher } from '../publisher.mjs';

const fixture = async (t) => {
	const root = await fs.mkdtemp(join(tmpdir(), 'blog-publisher-'));
	t.after(async () => {
		assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
		await fs.rm(root, { recursive: true, force: true });
	});
	const distDir = join(root, 'dist');
	await fs.mkdir(distDir);
	await fs.writeFile(join(distDir, 'index.html'), 'previous');
	const build = async (outDir) => {
		await fs.mkdir(outDir, { recursive: true });
		await fs.writeFile(join(outDir, 'index.html'), 'next');
		return 'built';
	};
	return { root, distDir, build };
};

test('publishes a complete build and cleans staging after success', async (t) => {
	const options = await fixture(t);
	assert.equal(await createPublisher(options)(), 'built');
	assert.equal(await fs.readFile(join(options.distDir, 'index.html'), 'utf8'), 'next');
	assert.deepEqual(await fs.readdir(join(options.root, '.admin-tmp')), []);
});

test('failed or incomplete builds leave the existing deployment intact', async (t) => {
	const options = await fixture(t);
	for (const build of [async () => { throw new Error('build failed'); }, async () => 'missing output']) {
		await assert.rejects(createPublisher({ ...options, build })());
		assert.equal(await fs.readFile(join(options.distDir, 'index.html'), 'utf8'), 'previous');
	}
});

for (const recoveryFails of [false, true]) {
	test(`failed deployment ${recoveryFails ? 'retains backup when recovery also fails' : 'restores the previous deployment'}`, async (t) => {
		const options = await fixture(t);
		const injectedFs = {
			...fs,
			rename: async (source, target) => {
				if (target === options.distDir && (recoveryFails || source.endsWith(`${sep}dist`))) {
					throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
				}
				return fs.rename(source, target);
			},
		};
		await assert.rejects(createPublisher({ ...options, fs: injectedFs, platform: 'linux' })(), recoveryFails ? /恢复文件保留在/ : /injected/);
		if (recoveryFails) {
			const [transaction] = await fs.readdir(join(options.root, '.admin-tmp'));
			assert.equal(await fs.readFile(join(options.root, '.admin-tmp', transaction, 'previous-dist/index.html'), 'utf8'), 'previous');
		} else {
			assert.equal(await fs.readFile(join(options.distDir, 'index.html'), 'utf8'), 'previous');
		}
	});
}
