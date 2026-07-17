import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PhotoItem {
	id: string;
	filename: string;
	url: string;
	key: string;
	contentType?: string;
	size?: number;
	hash?: string;
	createdAt?: string;
	collection?: 'blog' | 'photos';
}

const mediaLibraryPath = resolve(process.cwd(), 'server/data/media-library.json');

const readMediaLibrary = (): PhotoItem[] => {
	if (!existsSync(mediaLibraryPath)) return [];

	try {
		const items = JSON.parse(readFileSync(mediaLibraryPath, 'utf8'));
		return Array.isArray(items) ? items : [];
	} catch {
		return [];
	}
};

export const photos = readMediaLibrary()
	.filter((item) => item?.collection === 'photos')
	.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
