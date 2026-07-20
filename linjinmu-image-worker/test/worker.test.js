import assert from 'node:assert/strict';
import test from 'node:test';

import { getContentType, getObjectKey, isAllowedReferer } from '../src/worker.js';

test('referer validation compares exact origins', () => {
  assert.equal(isAllowedReferer(new Request('https://img.example/a.jpg')), true);
  assert.equal(isAllowedReferer(new Request('https://img.example/a.jpg', {
    headers: { Referer: 'https://example.com/photos' },
  })), true);
  assert.equal(isAllowedReferer(new Request('https://img.example/a.jpg', {
    headers: { Referer: 'https://example.com.evil.example/photos' },
  })), false);
  assert.equal(isAllowedReferer(new Request('https://img.example/a.jpg', {
    headers: { Referer: 'not a url' },
  })), false);
});

test('object key parsing decodes valid paths and rejects malformed input', () => {
  assert.equal(getObjectKey(new URL('https://img.example/folder/photo%201.webp')), 'folder/photo 1.webp');
  assert.equal(getObjectKey(new URL('https://img.example/')), null);
  assert.equal(getObjectKey(new URL('https://img.example/bad%E0%A4%A')), null);
  assert.equal(getObjectKey(new URL('https://img.example/a%00b.jpg')), null);
});

test('content type matching is case-insensitive and has a safe fallback', () => {
  assert.equal(getContentType('PHOTO.JPG'), 'image/jpeg');
  assert.equal(getContentType('photo.avif'), 'image/avif');
  assert.equal(getContentType('file.bin'), 'application/octet-stream');
});
