const DAILY_R2_READ_LIMIT = 100_000;
const COUNTER_TTL_SECONDS = 48 * 60 * 60;
const BROWSER_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const ALLOWED_REFERER_ORIGINS = new Set([
  'https://example.com',
  'https://www.example.com',
  'http://localhost:4321',
]);

const CONTENT_TYPES = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
});

function textResponse(body, status, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

export function isAllowedReferer(request) {
  const referer = request.headers.get('Referer');
  if (!referer) return true;

  try {
    return ALLOWED_REFERER_ORIGINS.has(new URL(referer).origin);
  } catch {
    return false;
  }
}

export function getObjectKey(url) {
  const encodedKey = url.pathname.replace(/^\/+/, '');
  if (!encodedKey) return null;

  try {
    const key = decodeURIComponent(encodedKey);
    return key.includes('\0') ? null : key;
  } catch {
    return null;
  }
}

export function getContentType(key) {
  const extension = key.split('.').pop()?.toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

function getDailyCounterKey(now = new Date()) {
  return `img:${now.toISOString().slice(0, 10)}:r2-reads`;
}

async function consumeR2ReadAllowance(env) {
  const key = getDailyCounterKey();
  const storedValue = await env.IMG_KV.get(key);
  const current = Number.parseInt(storedValue ?? '0', 10);
  const safeCurrent = Number.isFinite(current) && current >= 0 ? current : 0;

  if (safeCurrent >= DAILY_R2_READ_LIMIT) return false;

  // KV is eventually consistent, so this is a protective budget rather than a
  // transactionally exact counter. Exact enforcement would require a Durable Object.
  await env.IMG_KV.put(key, String(safeCurrent + 1), {
    expirationTtl: COUNTER_TTL_SECONDS,
  });
  return true;
}

function createCanonicalRequests(url, request) {
  const canonicalUrl = new URL(url);
  canonicalUrl.search = '';
  canonicalUrl.hash = '';

  const lookupHeaders = new Headers();
  for (const name of ['If-Modified-Since', 'If-None-Match', 'Range']) {
    const value = request.headers.get(name);
    if (value) lookupHeaders.set(name, value);
  }

  return {
    lookup: new Request(canonicalUrl, { method: 'GET', headers: lookupHeaders }),
    storage: new Request(canonicalUrl, { method: 'GET' }),
  };
}

function createObjectResponse(object) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);

  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', getContentType(object.key));
  }

  headers.set('Cache-Control', BROWSER_CACHE_CONTROL);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(object.size));
  headers.set('ETag', object.httpEtag);
  headers.set('Last-Modified', object.uploaded.toUTCString());
  headers.set('X-Content-Type-Options', 'nosniff');

  return new Response(object.body, { headers });
}

async function handleRequest(request, env, ctx) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return textResponse('Method Not Allowed', 405, { Allow: 'GET, HEAD' });
  }

  if (!isAllowedReferer(request)) {
    return textResponse('Forbidden', 403);
  }

  const url = new URL(request.url);
  const key = getObjectKey(url);
  if (!key) return textResponse('Not Found', 404);

  const cache = caches.default;
  const cacheRequests = createCanonicalRequests(url, request);
  const cached = await cache.match(cacheRequests.lookup);
  if (cached) return request.method === 'HEAD' ? new Response(null, cached) : cached;

  if (!(await consumeR2ReadAllowance(env))) {
    return textResponse('Daily image limit exceeded', 429, { 'Retry-After': '3600' });
  }

  const object = await env.BUCKET.get(key);
  if (!object) return textResponse('Not Found', 404);

  const fullResponse = createObjectResponse(object);
  ctx.waitUntil(
    cache.put(cacheRequests.storage, fullResponse.clone()).catch((error) => {
      console.error(JSON.stringify({
        message: 'cache write failed',
        key,
        error: error instanceof Error ? error.message : String(error),
      }));
    }),
  );

  return request.method === 'HEAD' ? new Response(null, fullResponse) : fullResponse;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({
        message: 'image request failed',
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return textResponse('Internal Server Error', 500);
    }
  },
};
