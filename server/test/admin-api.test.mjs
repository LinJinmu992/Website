import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { scryptSync } from 'node:crypto';
import { createAdminServer } from '../admin-app.mjs';
import { createPublisher } from '../publisher.mjs';

const post = { title: 'Test title', slug: 'first', date: '2026-09-09', description: 'Test description', body: '# Test body' };

const fixture = async (t, { authenticated = true } = {}) => {
	const root = await fs.mkdtemp(join(tmpdir(), 'blog-admin-api-'));
	const postsDir = join(root, 'src/content/posts');
	const distDir = join(root, 'dist');
	await fs.mkdir(postsDir, { recursive: true });
	await fs.mkdir(distDir);
	await fs.writeFile(join(distDir, 'index.html'), 'original deployment');
	const mode = { failBuild: false, failPublish: false, failRecovery: false };
	const publish = createPublisher({
		root, distDir, platform: 'linux',
		build: async (outDir) => {
			if (mode.failBuild) throw new Error('injected build failure');
			await fs.mkdir(outDir, { recursive: true });
			await fs.writeFile(join(outDir, 'index.html'), (await fs.readdir(postsDir)).filter((name) => name.endsWith('.md')).sort().join(','));
			return 'fixture build complete';
		},
		fs: { ...fs, rename: async (source, target) => {
			if (target === distDir && ((mode.failPublish && source.endsWith(`${sep}dist`)) || mode.failRecovery)) {
				throw Object.assign(new Error('injected publish failure'), { code: 'EIO' });
			}
			return fs.rename(source, target);
		} },
	});
	const salt = Buffer.from('fixture-salt');
	const passwordHash = `scrypt$16384$8$1$${salt.toString('base64url')}$${scryptSync('fixture-password', salt, 64).toString('base64url')}`;
	const server = await createAdminServer({ root, publish, env: {
		ADMIN_AUTH_DISABLED: String(authenticated), CONTENT_GIT_ENABLED: 'false',
		ADMIN_USERNAME: 'fixture-admin', ADMIN_PASSWORD_HASH: passwordHash, SESSION_SECRET: 'fixture-session-secret',
	} });
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(async () => {
		await new Promise((done, reject) => {
			server.close((error) => error ? reject(error) : done());
			server.closeAllConnections();
		});
		assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
		await fs.rm(root, { recursive: true, force: true });
	});
	const request = async (path, method = 'GET', body, cookie) => {
		const response = await fetch(`http://127.0.0.1:${server.address().port}/admin-api${path}`, {
			method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, cookie: response.headers.get('set-cookie'), data: await response.json() };
	};
	return { root, postsDir, distDir, mode, request };
};

test('admin HTTP API requires login and issues a working session cookie', async (t) => {
	const { request } = await fixture(t, { authenticated: false });
	assert.equal((await request('/posts')).status, 401);
	assert.equal((await request('/posts', 'POST', post)).status, 401);
	assert.equal((await request('/login', 'POST', { username: 'fixture-admin', password: 'wrong' })).status, 401);
	const login = await request('/login', 'POST', { username: 'fixture-admin', password: 'fixture-password' });
	assert.equal(login.status, 200);
	assert.match(login.cookie, /HttpOnly/);
	assert.equal((await request('/posts', 'GET', undefined, login.cookie.split(';')[0])).status, 200);
	assert.match((await request('/logout', 'POST', {})).cookie, /Max-Age=0/);
});

test('admin HTTP API publishes, edits, renames and deletes articles with collision protection', async (t) => {
	const { request, postsDir, distDir, root } = await fixture(t);
	assert.equal((await request('/posts', 'POST', { ...post, title: '' })).status, 400);
	assert.equal((await request('/posts', 'POST', post)).status, 201);
	assert.equal((await request('/posts', 'POST', post)).status, 409);
	assert.equal((await request('/posts/first', 'PUT', { ...post, title: '<img src=x onerror="alert(1)">' })).status, 200);
	assert.equal((await request('/posts/first')).data.post.title, '<img src=x onerror="alert(1)">');
	assert.equal((await request('/posts', 'POST', { ...post, slug: 'other' })).status, 201);
	assert.equal((await request('/posts/first', 'PUT', { ...post, slug: 'other' })).status, 409);
	assert.equal((await request('/posts/first', 'PUT', { ...post, slug: 'renamed' })).status, 200);
	await assert.rejects(fs.access(join(postsDir, 'first.md')), { code: 'ENOENT' });
	assert.equal((await request('/posts/renamed', 'DELETE')).status, 200);
	assert.equal(await fs.readFile(join(distDir, 'index.html'), 'utf8'), 'other.md');
	assert.equal((await fs.readdir(join(root, 'server/trash/posts'))).length, 2);
});

test('failed builds roll back article creation, edit, rename and deletion through HTTP', async (t) => {
	const { request, mode, postsDir, distDir } = await fixture(t);
	await request('/posts', 'POST', post);
	const previous = await fs.readFile(join(postsDir, 'first.md'), 'utf8');
	mode.failBuild = true;
	assert.equal((await request('/posts', 'POST', { ...post, slug: 'new' })).status, 500);
	assert.equal((await request('/posts/first', 'PUT', { ...post, body: 'changed' })).status, 500);
	assert.equal((await request('/posts/first', 'PUT', { ...post, slug: 'renamed' })).status, 500);
	assert.equal((await request('/posts/first', 'DELETE')).status, 500);
	assert.deepEqual(await fs.readdir(postsDir), ['first.md']);
	assert.equal(await fs.readFile(join(postsDir, 'first.md'), 'utf8'), previous);
	assert.equal(await fs.readFile(join(distDir, 'index.html'), 'utf8'), 'first.md');
	mode.failBuild = false;
	assert.equal((await request('/posts/first', 'PUT', { ...post, body: 'recovered' })).status, 200);
});

test('HTTP publish failures preserve the last deployment even if automatic recovery fails', async (t) => {
	const { request, mode, root, postsDir, distDir } = await fixture(t);
	await request('/posts', 'POST', post);
	mode.failPublish = true;
	assert.equal((await request('/posts/first', 'DELETE')).status, 500);
	assert.equal(await fs.readFile(join(distDir, 'index.html'), 'utf8'), 'first.md');
	mode.failRecovery = true;
	const result = await request('/posts/first', 'DELETE');
	assert.equal(result.status, 500);
	assert.match(result.data.error, /恢复文件保留在/);
	await fs.access(join(postsDir, 'first.md'));
	const [transaction] = await fs.readdir(join(root, '.admin-tmp'));
	assert.equal(await fs.readFile(join(root, '.admin-tmp', transaction, 'previous-dist/index.html'), 'utf8'), 'first.md');
});

test('concurrent creates for the same slug cannot overwrite each other', async (t) => {
	const { request } = await fixture(t);
	const results = await Promise.all([request('/posts', 'POST', post), request('/posts', 'POST', { ...post, body: 'second request' })]);
	assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
});
