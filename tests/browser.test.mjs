import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { chromium } from 'playwright';

let browser;
before(async () => {
	browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
});
after(async () => { await browser?.close(); });

const script = async (name) => stripTypeScriptTypes(await readFile(new URL(`../src/scripts/${name}.ts`, import.meta.url), 'utf8'))
	.replace("from './admin-client'", "from '/scripts/admin-client.js'");

const openFixture = async (t, { html, handle, width = 1200 }) => {
	const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
	t.after(() => page.close());
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.route('https://blog.test/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.startsWith('/scripts/')) {
			await route.fulfill({ contentType: 'text/javascript', body: await script(path.split('/').at(-1).replace('.js', '')) });
		} else if (await handle?.(route, path)) {
			return;
		} else if (path === '/') {
			await route.fulfill({ contentType: 'text/html', body: html });
		} else {
			await route.fulfill({ status: 404, body: 'missing' });
		}
	});
	await page.goto('https://blog.test/');
	return { page, errors };
};

const homeHtml = `<!doctype html><html><body><div class="page"><section class="recent">
<div class="post-list">${['a', 'b', 'c'].map((slug) => `<article data-post="${slug}"><a href="/posts/${slug}/" data-preview-link="${slug}">${slug}</a></article>`).join('')}</div>
<aside class="article-preview"><button class="preview-close">Close</button>
${['a', 'b', 'c'].map((slug) => `<article data-preview="${slug}" hidden><div class="preview-prose">Not loaded</div></article>`).join('')}
</aside></section></div><script type="module" src="/scripts/home.js"></script></body></html>`;

test('article admin displays markup and quoted filenames as text', async (t) => {
	const attack = '<img src=x onerror="window.__injected=1">';
	let failMedia = false;
	const { page, errors } = await openFixture(t, {
		html: '<form data-login></form><div data-post-manager><div data-post-list></div><div data-media-grid></div><button data-refresh-media>Refresh</button></div><script type="module" src="/scripts/admin-posts.js"></script>',
		handle: async (route, path) => {
			if (!path.startsWith('/admin-api/')) return false;
			const data = path.endsWith('/me') ? { authenticated: true }
				: path.endsWith('/posts') ? { posts: [{ title: attack, slug: 'fixture', date: attack, category: attack }] }
					: failMedia ? { error: attack } : { items: [{ filename: attack, url: 'https://blog.test/missing" onerror="window.__injected=1' }] };
			await route.fulfill({ status: failMedia && path.endsWith('/media') ? 500 : 200, json: data });
			return true;
		},
	});
	await page.waitForSelector('.post-admin-item h3');
	await page.waitForSelector('.media-item span');
	assert.equal(await page.locator('.post-admin-item h3').textContent(), attack);
	assert.equal(await page.locator('.media-item span').textContent(), attack);
	assert.equal(await page.locator('.media-item img').getAttribute('alt'), attack);
	assert.equal(await page.locator('[onerror]').count(), 0);
	assert.equal(await page.evaluate(() => window.__injected), undefined);
	failMedia = true;
	await page.locator('[data-refresh-media]').click();
	await page.waitForFunction((text) => document.querySelector('[data-media-grid]').textContent === text, attack);
	assert.equal(await page.locator('[onerror]').count(), 0);
	assert.deepEqual(errors, []);
});

test('desktop previews load on demand, cache, retry and ignore late responses after switching', async (t) => {
	const counts = { a: 0, b: 0, c: 0 };
	let releaseA;
	const waitA = new Promise((done) => { releaseA = done; });
	t.after(() => releaseA());
	const { page, errors } = await openFixture(t, {
		html: homeHtml,
		handle: async (route, path) => {
			const slug = /^\/posts\/([abc])\/$/.exec(path)?.[1];
			if (!slug) return false;
			counts[slug]++;
			if (slug === 'a') await waitA;
			if (slug === 'c' && counts.c === 1) await route.fulfill({ status: 503, body: 'retry later' });
			else await route.fulfill({ contentType: 'text/html', body: `<article class="post"><div class="prose"><p>Body ${slug}</p><a href="relative">Relative link</a></div></article>` });
			return true;
		},
	});
	assert.deepEqual(counts, { a: 0, b: 0, c: 0 });
	await page.locator('[data-preview-link=a]').click();
	await page.waitForSelector('[data-preview=a] [aria-busy=true]');
	await page.locator('[data-preview-link=b]').click();
	await page.waitForSelector('[data-preview=b][data-preview-active][data-preview-loaded=true]');
	releaseA();
	await page.waitForFunction(() => document.querySelector('[data-preview=a]').dataset.previewLoaded === 'true');
	assert.equal(await page.locator('[data-preview-active]').getAttribute('data-preview'), 'b');
	assert.equal(await page.locator('[data-preview=b] a').getAttribute('href'), 'https://blog.test/posts/b/relative');
	await page.locator('[data-preview-link=a]').click();
	await page.waitForSelector('[data-preview=a][data-preview-active]');
	assert.equal(counts.a, 1);
	// Switching away and immediately back must keep the last clicked article.
	await page.locator('[data-preview-link=b]').click();
	await page.locator('[data-preview-link=a]').click();
	await page.waitForSelector('[data-preview=a][data-preview-active]');
	await page.waitForTimeout(300);
	assert.equal(await page.locator('[data-preview-active]').getAttribute('data-preview'), 'a');
	await page.locator('[data-preview-link=c]').click();
	await page.locator('[data-preview=c] button').click();
	await page.waitForSelector('[data-preview=c][data-preview-loaded=true]');
	assert.equal(counts.c, 2);
	await page.locator('.preview-close').click();
	assert.equal(await page.locator('[data-preview-active]').count(), 0);
	assert.deepEqual(errors, []);
});

test('mobile article clicks navigate normally without fetching hidden previews', async (t) => {
	let requests = 0;
	const { page } = await openFixture(t, {
		html: homeHtml, width: 390,
		handle: async (route, path) => {
			if (path !== '/posts/a/') return false;
			requests++;
			assert.equal(route.request().isNavigationRequest(), true);
			await route.fulfill({ contentType: 'text/html', body: '<h1>Article</h1>' });
			return true;
		},
	});
	assert.equal(requests, 0);
	await page.locator('[data-preview-link=a]').click();
	await page.waitForURL('https://blog.test/posts/a/');
	assert.equal(requests, 1);
});
