import { resolve } from 'node:path';
import { readMediaItemsSync } from '../../server/media-store.mjs';

export interface PhotoItem {
	id: string;
	pipelineVersion?: number;
	filename: string;
	url: string;
	key: string;
	thumbnailUrl?: string;
	thumbnailKey?: string;
	width?: number;
	height?: number;
	thumbnailWidth?: number;
	thumbnailHeight?: number;
	contentType?: string;
	size?: number;
	hash?: string;
	createdAt?: string;
	collection?: 'blog' | 'photos';
}

const mediaLibraryPath = resolve(process.cwd(), 'server/data/media-library.json');
const mediaDatabasePath = resolve(process.cwd(), 'server/data/blog.db');

export const photos = (readMediaItemsSync({
	dbPath: mediaDatabasePath,
	legacyJsonPath: mediaLibraryPath,
	collection: 'photos',
}) as PhotoItem[])
	.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
