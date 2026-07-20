import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { access, copyFile, cp, mkdir, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { IMAGE_PIPELINE_VERSION, MAX_IMAGE_BYTES, optimizeUploadedImage } from './image-pipeline.mjs';
import { ContentGit, getContentGitConfig } from './content-git.mjs';
import { MediaStore } from './media-store.mjs';

const scryptAsync = promisify(scrypt);

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

const root = resolve(process.env.BLOG_ROOT ?? process.cwd());
const postsDir = resolve(root, 'src/content/posts');
const postsDataFile = resolve(root, 'src/data/posts.ts');
const photosDataFile = resolve(root, 'src/data/photos.ts');
const serverDataDir = resolve(root, 'server/data');
const trashPostsDir = resolve(root, 'server/trash/posts');
const mediaLibraryFile = resolve(serverDataDir, 'media-library.json');
const mediaDatabaseFile = resolve(serverDataDir, 'blog.db');
const adminTmpDir = resolve(root, '.admin-tmp');
const distDir = resolve(root, 'dist');
const host = process.env.ADMIN_HOST ?? '127.0.0.1';
const port = Number(process.env.ADMIN_PORT ?? 4322);
const username = process.env.ADMIN_USERNAME;
const passwordHash = process.env.ADMIN_PASSWORD_HASH;
const sessionSecret = process.env.SESSION_SECRET;
const autoBuild = process.env.BLOG_AUTO_BUILD !== 'false';
const authDisabled = process.env.ADMIN_AUTH_DISABLED === 'true';
const uploadBodyLimit = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024 * 1024;
const mediaStore = await MediaStore.open({
	dbPath: mediaDatabaseFile,
	legacyJsonPath: mediaLibraryFile,
});
const contentGit = new ContentGit({
	config: getContentGitConfig({ root }),
	postsDir,
});

let mutationQueue = Promise.resolve();

const withMutationLock = (task) => {
	const result = mutationQueue.then(task, task);
	mutationQueue = result.catch(() => undefined);
	return result;
};

const syncContentAfterMutation = async (message) => {
	if (!contentGit.config.enabled) return { enabled: false, synced: false, changed: false };
	try {
		return await contentGit.pushSnapshot(message);
	} catch (error) {
		console.error(JSON.stringify({
			message: 'Private article repository sync failed',
			error: error instanceof Error ? error.message : String(error),
		}));
		return {
			enabled: true,
			synced: false,
			changed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
};

const json = (res, status, body, headers = {}) => {
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		...headers,
	});
	res.end(JSON.stringify(body));
};

const readJson = async (req, limit = 12 * 1024 * 1024) => {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) {
			const error = new Error('图片过大，请上传小于 45 MB 的图片');
			error.statusCode = 413;
			throw error;
		}
		chunks.push(chunk);
	}

	if (!chunks.length) return {};
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const parseCookies = (req) => Object.fromEntries(
	(req.headers.cookie ?? '')
		.split(';')
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const index = part.indexOf('=');
			return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
		}),
);

const sign = (value) => createHmac('sha256', sessionSecret).update(value).digest('base64url');

const createSession = (user) => {
	const payload = Buffer.from(JSON.stringify({
		user,
		exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
		nonce: randomBytes(12).toString('base64url'),
	})).toString('base64url');

	return `${payload}.${sign(payload)}`;
};

const verifySession = (token) => {
	if (!sessionSecret || !token || !token.includes('.')) return false;
	const [payload, signature] = token.split('.');
	if (sign(payload) !== signature) return false;

	try {
		const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		return data.user === username && data.exp > Date.now();
	} catch {
		return false;
	}
};

const isAuthed = (req) => verifySession(parseCookies(req).blog_admin);
const isAllowed = (req) => authDisabled || isAuthed(req);

const verifyPassword = async (password) => {
	if (!username || !passwordHash || !sessionSecret) return false;
	const [scheme, n, r, p, salt, expected] = passwordHash.split('$');
	if (scheme !== 'scrypt') return false;

	const params = {
		N: Number(n),
		r: Number(r),
		p: Number(p),
		maxmem: 128 * 1024 * 1024,
	};
	const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), 64, params);
	const expectedBuffer = Buffer.from(expected, 'base64url');
	return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
};

const slugify = (value) => {
	const slug = String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/['"]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

	return slug || `post-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
};

const yamlValue = (value) => JSON.stringify(String(value ?? '').trim());

const buildMarkdown = ({ title, date, description, readTime, category, body }) => `---
title: ${yamlValue(title)}
date: ${yamlValue(date)}
description: ${yamlValue(description)}
readTime: ${yamlValue(readTime)}
category: ${yamlValue(category)}
---

${String(body ?? '').trim()}
`;

const parseMarkdownPost = (slug, source) => {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		return {
			slug,
			title: slug,
			date: '',
			description: '',
			readTime: '',
			category: '日常',
			body: source,
		};
	}

	const frontmatter = {};
	match[1].split(/\r?\n/).forEach((line) => {
		const separator = line.indexOf(':');
		if (separator === -1) return;
		const key = line.slice(0, separator).trim();
		let value = line.slice(separator + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			try {
				value = JSON.parse(value);
			} catch {
				value = value.slice(1, -1);
			}
		}
		frontmatter[key] = value;
	});

	return {
		slug,
		title: frontmatter.title ?? slug,
		date: frontmatter.date ?? '',
		description: frontmatter.description ?? '',
		readTime: frontmatter.readTime ?? '',
		category: frontmatter.category === '笔记' ? '笔记' : '日常',
		body: match[2].trim(),
	};
};

const pathExists = async (path) => access(path).then(() => true, () => false);

const renameWithRetry = async (source, target, attempts = 7) => {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			await rename(source, target);
			return;
		} catch (error) {
			lastError = error;
			const retryable = ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code);
			if (!retryable || attempt === attempts) throw error;
			await new Promise((resolveRetry) => setTimeout(resolveRetry, 75 * attempt));
		}
	}
	throw lastError;
};

const createTransactionDir = async (prefix) => {
	const directory = resolve(adminTmpDir, `${prefix}-${Date.now()}-${randomBytes(6).toString('hex')}`);
	await mkdir(directory, { recursive: true });
	return directory;
};

const atomicWriteFile = async (target, content, options = {}) => {
	const transactionDir = await createTransactionDir('write');
	const temporary = resolve(transactionDir, 'next');
	try {
		await writeFile(temporary, content, options);
		await rename(temporary, target);
	} finally {
		await rm(transactionDir, { recursive: true, force: true }).catch(() => undefined);
	}
};

const spawnBuild = (outDir) => new Promise((resolveBuild, reject) => {
	const child = spawn('npm', ['run', 'build', '--', '--outDir', outDir], {
		cwd: root,
		shell: true,
		env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
	});
	let output = '';
	child.stdout.on('data', (data) => { output += data.toString(); });
	child.stderr.on('data', (data) => { output += data.toString(); });
	child.on('error', reject);
	child.on('close', (code) => {
		if (code === 0) resolveBuild(output);
		else reject(new Error(output || `Build failed with code ${code}`));
	});
});

const runBuild = async () => {
	const transactionDir = await createTransactionDir('build');
	const stagedDist = resolve(transactionDir, 'dist');
	const previousDist = resolve(transactionDir, 'previous-dist');
	let previousMoved = false;

	try {
		const output = await spawnBuild(stagedDist);
		if (await pathExists(distDir)) {
			await renameWithRetry(distDir, previousDist);
			previousMoved = true;
		}

		try {
			try {
				await renameWithRetry(stagedDist, distDir);
			} catch (error) {
				if (process.platform !== 'win32' || !['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
				await cp(stagedDist, distDir, { recursive: true, force: true });
				await rm(stagedDist, { recursive: true, force: true });
			}
		} catch (error) {
			await rm(distDir, { recursive: true, force: true }).catch(() => undefined);
			if (previousMoved) {
				await renameWithRetry(previousDist, distDir).catch(() => undefined);
			}
			throw error;
		}

		return output;
	} finally {
		await rm(transactionDir, { recursive: true, force: true }).catch(() => undefined);
	}
};

const safePostPath = (slug) => {
	const file = `${slugify(slug)}.md`;
	const target = resolve(postsDir, file);
	if (!target.startsWith(postsDir)) throw new Error('Invalid post path');
	return target;
};

const readPost = async (slug) => {
	const normalized = slugify(slug);
	const source = await readFile(safePostPath(normalized), 'utf8');
	return parseMarkdownPost(normalized, source);
};

const listPosts = async () => {
	await mkdir(postsDir, { recursive: true });
	const files = await readdir(postsDir);
	const posts = await Promise.all(
		files
			.filter((file) => file.endsWith('.md'))
			.map(async (file) => {
				const slug = file.replace(/\.md$/, '');
				const source = await readFile(resolve(postsDir, file), 'utf8');
				const post = parseMarkdownPost(slug, source);
				return {
					slug: post.slug,
					title: post.title,
					date: post.date,
					description: post.description,
					category: post.category,
					readTime: post.readTime,
					url: `/posts/${post.slug}`,
				};
			}),
	);

	return posts.sort((a, b) => String(b.date).localeCompare(String(a.date)));
};

const rebuildIfNeeded = async () => {
	await touchDevWatcher();
	if (!autoBuild) return '';
	return runBuild();
};

const touchDevWatcher = async () => {
	const now = new Date();
	await utimes(postsDataFile, now, now).catch(() => null);
	await utimes(photosDataFile, now, now).catch(() => null);
};

const normalizeMediaCollection = (value) => (value === 'photos' ? 'photos' : 'blog');

const readMediaLibrary = async () => mediaStore.list();

const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const encodePath = (key) => key.split('/').map(encodeURIComponent).join('/');

const getR2Config = () => {
	const {
		R2_ACCOUNT_ID,
		R2_ACCESS_KEY_ID,
		R2_SECRET_ACCESS_KEY,
		R2_BUCKET,
		R2_PUBLIC_BASE_URL,
	} = process.env;

	if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_BASE_URL) {
		throw new Error('R2 environment variables are not configured');
	}

	return { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL };
};

const createR2Key = ({ filename, hash, collection, suffix = '' }) => {
	const now = new Date();
	const folder = now.toISOString().slice(0, 7).replace('-', '/');
	const prefix = normalizeMediaCollection(collection);
	const basename = slugify(String(filename).replace(/\.[^.]+$/, ''));
	return `${prefix}/${folder}/${basename}-${hash.slice(0, 12)}${suffix}.webp`;
};

const requestR2 = async ({ method, key, contentType = 'application/octet-stream', buffer = Buffer.alloc(0) }) => {
	const {
		R2_ACCOUNT_ID,
		R2_ACCESS_KEY_ID,
		R2_SECRET_ACCESS_KEY,
		R2_BUCKET,
	} = getR2Config();

	const now = new Date();
	const date = now.toISOString().slice(0, 10).replaceAll('-', '');
	const amzDate = `${date}T${now.toISOString().slice(11, 19).replaceAll(':', '')}Z`;
	const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
	const path = `/${R2_BUCKET}/${encodePath(key)}`;
	const payloadHash = sha256(buffer);
	const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
	const canonicalHeaders = [
		`content-type:${contentType}`,
		`host:${host}`,
		`x-amz-content-sha256:${payloadHash}`,
		`x-amz-date:${amzDate}`,
		'',
	].join('\n');
	const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
	const credentialScope = `${date}/auto/s3/aws4_request`;
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		amzDate,
		credentialScope,
		sha256(canonicalRequest),
	].join('\n');
	const dateKey = hmac(`AWS4${R2_SECRET_ACCESS_KEY}`, date);
	const regionKey = hmac(dateKey, 'auto');
	const serviceKey = hmac(regionKey, 's3');
	const signingKey = hmac(serviceKey, 'aws4_request');
	const signature = hmac(signingKey, stringToSign, 'hex');
	const authorization = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	const response = await fetch(`https://${host}${path}`, {
		method,
		headers: {
			authorization,
			'content-type': contentType,
			'x-amz-content-sha256': payloadHash,
			'x-amz-date': amzDate,
		},
		body: method === 'DELETE' ? undefined : buffer,
	});

	if (!response.ok) {
		throw new Error(`R2 ${method} failed: ${response.status} ${await response.text()}`);
	}
	return response;
};

const uploadToR2 = async ({ key, contentType, buffer }) => {
	const { R2_PUBLIC_BASE_URL } = getR2Config();
	await requestR2({ method: 'PUT', key, contentType, buffer });

	return {
		key,
		url: `${R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`,
	};
};

const deleteFromR2 = async (key) => {
	if (!key) return;
	await requestR2({ method: 'DELETE', key }).catch((error) => {
		console.error(JSON.stringify({
			message: 'R2 cleanup failed',
			key,
			error: error instanceof Error ? error.message : String(error),
		}));
	});
};

const requireAuth = (req, res) => {
	if (isAllowed(req)) return true;
	json(res, 401, { ok: false, error: 'Unauthorized' });
	return false;
};

createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`);

		if (req.method === 'GET' && url.pathname === '/admin-api/me') {
			json(res, 200, { ok: true, authenticated: isAllowed(req), authDisabled, username });
			return;
		}

		if (req.method === 'GET' && url.pathname === '/admin-api/git/status') {
			if (!requireAuth(req, res)) return;
			json(res, 200, { ok: true, ...contentGit.publicStatus() });
			return;
		}

		if (req.method === 'POST' && url.pathname === '/admin-api/git/test') {
			if (!requireAuth(req, res)) return;
			const config = await contentGit.testConnection();
			json(res, 200, {
				ok: true,
				connected: true,
				repository: config.repository,
				branch: config.branch,
			});
			return;
		}

		if (req.method === 'POST' && url.pathname === '/admin-api/git/sync') {
			if (!requireAuth(req, res)) return;
			const gitSync = await withMutationLock(() => contentGit.pushSnapshot('Manual blog content sync'));
			json(res, 200, { ok: true, gitSync });
			return;
		}

		if (req.method === 'POST' && url.pathname === '/admin-api/login') {
			if (authDisabled) {
				json(res, 200, { ok: true, authDisabled });
				return;
			}

			const body = await readJson(req);
			if (body.username !== username || !(await verifyPassword(body.password))) {
				json(res, 401, { ok: false, error: '用户名或密码不正确' });
				return;
			}

			const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
			json(res, 200, { ok: true }, {
				'set-cookie': `blog_admin=${encodeURIComponent(createSession(username))}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${secure}`,
			});
			return;
		}

		if (req.method === 'POST' && url.pathname === '/admin-api/logout') {
			json(res, 200, { ok: true }, {
				'set-cookie': 'blog_admin=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax',
			});
			return;
		}

		if (req.method === 'GET' && url.pathname === '/admin-api/media') {
			if (!requireAuth(req, res)) return;
			const collection = url.searchParams.get('collection');
			const items = (await readMediaLibrary())
				.filter((item) => !collection || normalizeMediaCollection(item.collection) === normalizeMediaCollection(collection));
			json(res, 200, { ok: true, items });
			return;
		}

		if (req.method === 'GET' && url.pathname === '/admin-api/posts') {
			if (!requireAuth(req, res)) return;
			json(res, 200, { ok: true, posts: await listPosts() });
			return;
		}

		const postMatch = url.pathname.match(/^\/admin-api\/posts\/([^/]+)$/);
		if (postMatch && req.method === 'GET') {
			if (!requireAuth(req, res)) return;
			const slug = decodeURIComponent(postMatch[1]);
			json(res, 200, { ok: true, post: await readPost(slug) });
			return;
		}

		if (postMatch && req.method === 'PUT') {
			if (!requireAuth(req, res)) return;
			const currentSlug = slugify(decodeURIComponent(postMatch[1]));
			const body = await readJson(req, 2 * 1024 * 1024);
			const nextSlug = slugify(body.slug || body.title || currentSlug);
			const category = body.category === '笔记' ? '笔记' : '日常';
			const date = body.date || new Date().toISOString().slice(0, 10);

			if (!body.title || !body.description || !body.body) {
				json(res, 400, { ok: false, error: '标题、描述和正文不能为空' });
				return;
			}

			const markdown = buildMarkdown({
				title: body.title,
				date,
				description: body.description,
				readTime: body.readTime || '3 分钟',
				category,
				body: body.body,
			});

			const buildOutput = await withMutationLock(async () => {
				const currentPath = safePostPath(currentSlug);
				const nextPath = safePostPath(nextSlug);
				const transactionDir = await createTransactionDir('post-update');
				const backupPath = resolve(transactionDir, `${currentSlug}.md`);
				await readFile(currentPath, 'utf8');

				try {
					if (nextSlug === currentSlug) {
						await copyFile(currentPath, backupPath);
						await atomicWriteFile(currentPath, markdown, 'utf8');
						try {
							return await rebuildIfNeeded();
						} catch (error) {
							await atomicWriteFile(currentPath, await readFile(backupPath));
							throw error;
						}
					}

					if (await pathExists(nextPath)) {
						const error = new Error('新的 Slug 已经存在');
						error.statusCode = 409;
						throw error;
					}

					await atomicWriteFile(nextPath, markdown, 'utf8');
					await rename(currentPath, backupPath);
					try {
						const output = await rebuildIfNeeded();
						await mkdir(trashPostsDir, { recursive: true });
						await rename(backupPath, resolve(trashPostsDir, `${currentSlug}-${Date.now()}.md`));
						return output;
					} catch (error) {
						await rm(nextPath, { force: true }).catch(() => undefined);
						if (await pathExists(backupPath)) await rename(backupPath, currentPath);
						throw error;
					}
				} finally {
					await rm(transactionDir, { recursive: true, force: true }).catch(() => undefined);
				}
			});
			const gitSync = await withMutationLock(() => syncContentAfterMutation(`Update post: ${nextSlug}`));
			json(res, 200, {
				ok: true,
				slug: nextSlug,
				url: `/posts/${nextSlug}`,
				built: autoBuild,
				buildOutput,
				gitSync,
			});
			return;
		}

		if (postMatch && req.method === 'DELETE') {
			if (!requireAuth(req, res)) return;
			const slug = slugify(decodeURIComponent(postMatch[1]));
			const buildOutput = await withMutationLock(async () => {
				const source = safePostPath(slug);
				const transactionDir = await createTransactionDir('post-delete');
				const backupPath = resolve(transactionDir, `${slug}.md`);
				await rename(source, backupPath);
				try {
					const output = await rebuildIfNeeded();
					await mkdir(trashPostsDir, { recursive: true });
					await rename(backupPath, resolve(trashPostsDir, `${slug}-${Date.now()}.md`));
					return output;
				} catch (error) {
					if (await pathExists(backupPath)) await rename(backupPath, source);
					throw error;
				} finally {
					await rm(transactionDir, { recursive: true, force: true }).catch(() => undefined);
				}
			});
			const gitSync = await withMutationLock(() => syncContentAfterMutation(`Delete post: ${slug}`));
			json(res, 200, { ok: true, slug, built: autoBuild, buildOutput, gitSync });
			return;
		}

		if (req.method === 'POST' && url.pathname === '/admin-api/posts') {
			if (!requireAuth(req, res)) return;
			const body = await readJson(req, 2 * 1024 * 1024);
			const category = body.category === '笔记' ? '笔记' : '日常';
			const date = body.date || new Date().toISOString().slice(0, 10);
			const slug = slugify(body.slug || body.title);

			if (!body.title || !body.description || !body.body) {
				json(res, 400, { ok: false, error: '标题、描述和正文不能为空' });
				return;
			}

			const markdown = buildMarkdown({
				title: body.title,
				date,
				description: body.description,
				readTime: body.readTime || '3 分钟',
				category,
				body: body.body,
			});
			const target = safePostPath(slug);
			const buildOutput = await withMutationLock(async () => {
				await mkdir(postsDir, { recursive: true });
				if (await pathExists(target)) {
					const error = new Error('Slug 已经存在');
					error.statusCode = 409;
					throw error;
				}

				await atomicWriteFile(target, markdown, 'utf8');
				try {
					return await rebuildIfNeeded();
				} catch (error) {
					await rm(target, { force: true }).catch(() => undefined);
					throw error;
				}
			});
			const gitSync = await withMutationLock(() => syncContentAfterMutation(`Publish post: ${slug}`));
			json(res, 201, {
				ok: true,
				slug,
				url: `/posts/${slug}`,
				path: target,
				built: autoBuild,
				buildOutput,
				gitSync,
			});
			return;
		}

		if (req.method === 'POST' && url.pathname === '/admin-api/upload') {
			if (!requireAuth(req, res)) return;
			const body = await readJson(req, uploadBodyLimit);
			if (!body.filename || !body.data) {
				json(res, 400, { ok: false, error: '缺少文件' });
				return;
			}

			const buffer = Buffer.from(String(body.data), 'base64');
			const hash = sha256(buffer);
			const collection = normalizeMediaCollection(body.collection);
			const optimized = await optimizeUploadedImage(buffer, { collection });

			const result = await withMutationLock(async () => {
				const existing = mediaStore.findReusable(hash, collection, IMAGE_PIPELINE_VERSION);
				if (existing) return { reused: true, item: existing, buildOutput: '' };

				const fullKey = createR2Key({ filename: body.filename, hash, collection });
				const thumbnailKey = optimized.thumbnail
					? createR2Key({ filename: body.filename, hash, collection, suffix: '-thumb' })
					: null;
				let uploaded = null;
				let thumbnail = null;

				try {
					if (optimized.thumbnail && thumbnailKey) {
						thumbnail = await uploadToR2({
							key: thumbnailKey,
							contentType: optimized.thumbnail.contentType,
							buffer: optimized.thumbnail.buffer,
						});
					}

					uploaded = await uploadToR2({
						key: fullKey,
						contentType: optimized.full.contentType,
						buffer: optimized.full.buffer,
					});

					const item = {
						id: randomBytes(8).toString('hex'),
						pipelineVersion: IMAGE_PIPELINE_VERSION,
						collection,
						filename: body.filename,
						contentType: optimized.full.contentType,
						size: optimized.full.size,
						originalSize: optimized.original.size,
						width: optimized.full.width,
						height: optimized.full.height,
						hash,
						key: uploaded.key,
						url: uploaded.url,
						thumbnailKey: thumbnail?.key,
						thumbnailUrl: thumbnail?.url,
						thumbnailWidth: optimized.thumbnail?.width,
						thumbnailHeight: optimized.thumbnail?.height,
						createdAt: new Date().toISOString(),
					};
					const replacedItems = mediaStore.upsert(item);

					try {
						const buildOutput = collection === 'photos' ? await rebuildIfNeeded() : '';
						return { reused: false, item, buildOutput };
					} catch (error) {
						mediaStore.rollbackUpsert(item.id, replacedItems);
						throw error;
					}
				} catch (error) {
					await deleteFromR2(uploaded?.key);
					await deleteFromR2(thumbnail?.key);
					throw error;
				}
			});

			json(res, result.reused ? 200 : 201, {
				ok: true,
				reused: result.reused,
				item: result.item,
				url: result.item.url,
				built: !result.reused && collection === 'photos' && autoBuild,
				buildOutput: result.buildOutput,
			});
			return;
		}

		json(res, 404, { ok: false, error: 'Not found' });
	} catch (error) {
		json(res, error.statusCode ?? 500, { ok: false, error: error.message ?? String(error) });
	}
}).listen(port, host, () => {
	console.log(`Admin API listening on http://${host}:${port}`);
});
