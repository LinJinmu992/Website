import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, utimes, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';

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
const port = Number(process.env.ADMIN_PORT ?? 4322);
const username = process.env.ADMIN_USERNAME;
const passwordHash = process.env.ADMIN_PASSWORD_HASH;
const sessionSecret = process.env.SESSION_SECRET;
const autoBuild = process.env.BLOG_AUTO_BUILD !== 'false';
const authDisabled = process.env.ADMIN_AUTH_DISABLED !== 'false';
const uploadBodyLimit = 64 * 1024 * 1024;

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

const runBuild = () => new Promise((resolveBuild, reject) => {
	const child = spawn('npm', ['run', 'build'], {
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

const readMediaLibrary = async () => {
	try {
		const raw = await readFile(mediaLibraryFile, 'utf8');
		const items = JSON.parse(raw);
		return Array.isArray(items) ? items : [];
	} catch {
		return [];
	}
};

const writeMediaLibrary = async (items) => {
	await mkdir(serverDataDir, { recursive: true });
	await writeFile(mediaLibraryFile, JSON.stringify(items, null, 2), 'utf8');
};

const addMediaItem = async (item) => {
	const items = await readMediaLibrary();
	const next = [
		item,
		...items.filter((existing) => existing.url !== item.url),
	].slice(0, 500);
	await writeMediaLibrary(next);
	return next;
};

const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const encodePath = (key) => key.split('/').map(encodeURIComponent).join('/');

const uploadToR2 = async ({ filename, contentType, buffer, hash, collection }) => {
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

	const now = new Date();
	const date = now.toISOString().slice(0, 10).replaceAll('-', '');
	const amzDate = `${date}T${now.toISOString().slice(11, 19).replaceAll(':', '')}Z`;
	const folder = now.toISOString().slice(0, 7).replace('-', '/');
	const prefix = normalizeMediaCollection(collection);
	const extension = extname(filename).toLowerCase() || '.bin';
	const basename = slugify(filename.replace(/\.[^.]+$/, ''));
	const key = `${prefix}/${folder}/${basename}-${hash.slice(0, 12)}${extension}`;
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
	const canonicalRequest = ['PUT', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
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
		method: 'PUT',
		headers: {
			authorization,
			'content-type': contentType,
			'x-amz-content-sha256': payloadHash,
			'x-amz-date': amzDate,
		},
		body: buffer,
	});

	if (!response.ok) {
		throw new Error(`R2 upload failed: ${response.status} ${await response.text()}`);
	}

	return {
		key,
		url: `${R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`,
	};
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

			const currentPath = safePostPath(currentSlug);
			const nextPath = safePostPath(nextSlug);
			await readFile(currentPath, 'utf8');
			await writeFile(nextPath, buildMarkdown({
				title: body.title,
				date,
				description: body.description,
				readTime: body.readTime || '3 分钟',
				category,
				body: body.body,
			}), 'utf8');

			if (nextSlug !== currentSlug) {
				await mkdir(trashPostsDir, { recursive: true });
				await rename(currentPath, resolve(trashPostsDir, `${currentSlug}-${Date.now()}.md`));
			}

			const buildOutput = await rebuildIfNeeded();
			json(res, 200, {
				ok: true,
				slug: nextSlug,
				url: `/posts/${nextSlug}`,
				built: autoBuild,
				buildOutput,
			});
			return;
		}

		if (postMatch && req.method === 'DELETE') {
			if (!requireAuth(req, res)) return;
			const slug = slugify(decodeURIComponent(postMatch[1]));
			const source = safePostPath(slug);
			await mkdir(trashPostsDir, { recursive: true });
			await rename(source, resolve(trashPostsDir, `${slug}-${Date.now()}.md`));
			const buildOutput = await rebuildIfNeeded();
			json(res, 200, { ok: true, slug, built: autoBuild, buildOutput });
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

			await mkdir(postsDir, { recursive: true });
			const target = safePostPath(slug);
			await writeFile(target, buildMarkdown({
				title: body.title,
				date,
				description: body.description,
				readTime: body.readTime || '3 分钟',
				category,
				body: body.body,
			}), { flag: 'wx' });
			const buildOutput = await rebuildIfNeeded();
			json(res, 201, {
				ok: true,
				slug,
				url: `/posts/${slug}`,
				path: target,
				built: autoBuild,
				buildOutput,
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
			const existing = (await readMediaLibrary())
				.find((item) => item.hash === hash && normalizeMediaCollection(item.collection) === collection);
			if (existing) {
				json(res, 200, { ok: true, reused: true, item: existing, url: existing.url });
				return;
			}

			const uploaded = await uploadToR2({
				filename: body.filename,
				contentType: body.contentType || 'application/octet-stream',
				buffer,
				hash,
				collection,
			});
			const item = {
				id: randomBytes(8).toString('hex'),
				collection,
				filename: body.filename,
				contentType: body.contentType || 'application/octet-stream',
				size: buffer.length,
				hash,
				key: uploaded.key,
				url: uploaded.url,
				createdAt: new Date().toISOString(),
			};
			await addMediaItem(item);
			const buildOutput = collection === 'photos' ? await rebuildIfNeeded() : '';
			json(res, 201, { ok: true, reused: false, item, url: item.url, built: collection === 'photos' && autoBuild, buildOutput });
			return;
		}

		json(res, 404, { ok: false, error: 'Not found' });
	} catch (error) {
		json(res, error.statusCode ?? 500, { ok: false, error: error.message ?? String(error) });
	}
}).listen(port, () => {
	console.log(`Admin API listening on http://127.0.0.1:${port}`);
});
