import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { ImageValidationError, optimizeUploadedImage } from '../image-pipeline.mjs';

test('photography uploads create an optimized image and a 4:3 thumbnail', async () => {
	const source = await sharp({
		create: { width: 1800, height: 1200, channels: 3, background: '#7259a8' },
	})
		.jpeg()
		.withMetadata({ exif: { IFD0: { Artist: 'private metadata' } } })
		.toBuffer();

	const result = await optimizeUploadedImage(source, { collection: 'photos' });
	const fullMetadata = await sharp(result.full.buffer).metadata();
	const thumbnailMetadata = await sharp(result.thumbnail.buffer).metadata();

	assert.equal(fullMetadata.format, 'webp');
	assert.equal(fullMetadata.exif, undefined);
	assert.equal(result.full.width, 1800);
	assert.equal(result.full.height, 1200);
	assert.equal(thumbnailMetadata.format, 'webp');
	assert.equal(result.thumbnail.width, 960);
	assert.equal(result.thumbnail.height, 720);
});

test('portrait photography uploads create a 3:4 thumbnail', async () => {
	const source = await sharp({
		create: { width: 1200, height: 1800, channels: 3, background: '#7259a8' },
	})
		.jpeg()
		.toBuffer();

	const result = await optimizeUploadedImage(source, { collection: 'photos' });

	assert.equal(result.full.width, 1200);
	assert.equal(result.full.height, 1800);
	assert.equal(result.thumbnail.width, 720);
	assert.equal(result.thumbnail.height, 960);
});

test('blog uploads are resized without enlargement and do not create thumbnails', async () => {
	const source = await sharp({
		create: { width: 3200, height: 1800, channels: 3, background: '#eeeeee' },
	}).png().toBuffer();

	const result = await optimizeUploadedImage(source, { collection: 'blog' });
	assert.equal(result.full.width, 2400);
	assert.equal(result.full.height, 1350);
	assert.equal(result.thumbnail, null);
});

test('non-image uploads are rejected', async () => {
	await assert.rejects(
		optimizeUploadedImage(Buffer.from('not an image')),
		(error) => error instanceof ImageValidationError && error.statusCode === 400,
	);
});
