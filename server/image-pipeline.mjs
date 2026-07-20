import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 45 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const IMAGE_PIPELINE_VERSION = 2;

const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);

export class ImageValidationError extends Error {
	constructor(message, statusCode = 400) {
		super(message);
		this.name = 'ImageValidationError';
		this.statusCode = statusCode;
	}
}

const openImage = (buffer) => sharp(buffer, {
	failOn: 'warning',
	limitInputPixels: MAX_IMAGE_PIXELS,
});

export const optimizeUploadedImage = async (buffer, { collection = 'blog' } = {}) => {
	if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
		throw new ImageValidationError('图片内容为空');
	}

	if (buffer.length > MAX_IMAGE_BYTES) {
		throw new ImageValidationError('图片过大，请上传小于 45 MB 的图片', 413);
	}

	let metadata;
	try {
		metadata = await openImage(buffer).metadata();
	} catch {
		throw new ImageValidationError('无法识别图片内容，请上传有效的 JPEG、PNG、WebP 或 AVIF 图片');
	}

	if (!metadata.format || !SUPPORTED_FORMATS.has(metadata.format)) {
		throw new ImageValidationError('仅支持 JPEG、PNG、WebP 和 AVIF 图片');
	}

	if (!metadata.width || !metadata.height) {
		throw new ImageValidationError('无法读取图片尺寸');
	}

	if ((metadata.pages ?? 1) > 1) {
		throw new ImageValidationError('暂不支持动态图片');
	}

	const maxEdge = collection === 'photos' ? 3200 : 2400;
	let full;
	try {
		full = await openImage(buffer)
			.rotate()
			.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
			.webp({ quality: collection === 'photos' ? 86 : 84, effort: 4 })
			.toBuffer({ resolveWithObject: true });
	} catch {
		throw new ImageValidationError('图片解码失败，文件可能已损坏');
	}

	let thumbnail = null;
	if (collection === 'photos') {
		const swapsDimensions = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
		const orientedWidth = swapsDimensions ? metadata.height : metadata.width;
		const orientedHeight = swapsDimensions ? metadata.width : metadata.height;
		const isPortrait = orientedHeight > orientedWidth;
		const isSquare = orientedHeight === orientedWidth;
		const thumbnailWidth = isPortrait ? 720 : 960;
		const thumbnailHeight = isPortrait ? 960 : (isSquare ? 960 : 720);

		thumbnail = await openImage(buffer)
			.rotate()
			.resize({
				width: thumbnailWidth,
				height: thumbnailHeight,
				fit: 'cover',
				position: 'centre',
				withoutEnlargement: true,
			})
			.webp({ quality: 78, effort: 4 })
			.toBuffer({ resolveWithObject: true });
	}

	return {
		original: {
			format: metadata.format,
			width: metadata.width,
			height: metadata.height,
			size: buffer.length,
		},
		full: {
			buffer: full.data,
			contentType: 'image/webp',
			extension: '.webp',
			width: full.info.width,
			height: full.info.height,
			size: full.info.size,
		},
		thumbnail: thumbnail ? {
			buffer: thumbnail.data,
			contentType: 'image/webp',
			extension: '.webp',
			width: thumbnail.info.width,
			height: thumbnail.info.height,
			size: thumbnail.info.size,
		} : null,
	};
};
