import { DatabaseSync, backup as backupDatabase } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const columns = [
	'id', 'pipeline_version', 'collection', 'filename', 'content_type', 'size', 'original_size',
	'width', 'height', 'hash', 'key', 'url', 'thumbnail_key', 'thumbnail_url',
	'thumbnail_width', 'thumbnail_height', 'created_at',
];

const toRow = (item) => ({
	id: item.id,
	pipeline_version: item.pipelineVersion ?? null,
	collection: item.collection === 'photos' ? 'photos' : 'blog',
	filename: item.filename,
	content_type: item.contentType ?? null,
	size: item.size ?? null,
	original_size: item.originalSize ?? null,
	width: item.width ?? null,
	height: item.height ?? null,
	hash: item.hash ?? null,
	key: item.key,
	url: item.url,
	thumbnail_key: item.thumbnailKey ?? null,
	thumbnail_url: item.thumbnailUrl ?? null,
	thumbnail_width: item.thumbnailWidth ?? null,
	thumbnail_height: item.thumbnailHeight ?? null,
	created_at: item.createdAt ?? new Date().toISOString(),
});

const fromRow = (row) => ({
	id: row.id,
	pipelineVersion: row.pipeline_version ?? undefined,
	collection: row.collection,
	filename: row.filename,
	contentType: row.content_type ?? undefined,
	size: row.size ?? undefined,
	originalSize: row.original_size ?? undefined,
	width: row.width ?? undefined,
	height: row.height ?? undefined,
	hash: row.hash ?? undefined,
	key: row.key,
	url: row.url,
	thumbnailKey: row.thumbnail_key ?? undefined,
	thumbnailUrl: row.thumbnail_url ?? undefined,
	thumbnailWidth: row.thumbnail_width ?? undefined,
	thumbnailHeight: row.thumbnail_height ?? undefined,
	createdAt: row.created_at,
});

const createSchema = (database) => {
	database.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = FULL;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS media_items (
			id TEXT PRIMARY KEY,
			pipeline_version INTEGER,
			collection TEXT NOT NULL CHECK (collection IN ('blog', 'photos')),
			filename TEXT NOT NULL,
			content_type TEXT,
			size INTEGER,
			original_size INTEGER,
			width INTEGER,
			height INTEGER,
			hash TEXT,
			key TEXT NOT NULL UNIQUE,
			url TEXT NOT NULL UNIQUE,
			thumbnail_key TEXT,
			thumbnail_url TEXT,
			thumbnail_width INTEGER,
			thumbnail_height INTEGER,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS media_items_collection_created
			ON media_items (collection, created_at DESC);
		CREATE TABLE IF NOT EXISTS app_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
};

const createStatements = (database) => ({
	insert: database.prepare(`
		INSERT INTO media_items (${columns.join(', ')})
		VALUES (${columns.map((column) => `@${column}`).join(', ')})
	`),
	list: database.prepare('SELECT * FROM media_items ORDER BY created_at DESC'),
	listCollection: database.prepare('SELECT * FROM media_items WHERE collection = ? ORDER BY created_at DESC'),
	findReusable: database.prepare(`
		SELECT * FROM media_items
		WHERE hash = ? AND collection = ? AND pipeline_version = ?
		LIMIT 1
	`),
	findConflicts: database.prepare(`
		SELECT * FROM media_items
		WHERE url = @url OR (hash = @hash AND collection = @collection)
	`),
	deleteConflicts: database.prepare(`
		DELETE FROM media_items
		WHERE url = @url OR (hash = @hash AND collection = @collection)
	`),
	deleteById: database.prepare('DELETE FROM media_items WHERE id = ?'),
	count: database.prepare('SELECT COUNT(*) AS count FROM media_items'),
	getMeta: database.prepare('SELECT value FROM app_meta WHERE key = ?'),
	setMeta: database.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)'),
});

export class MediaStore {
	static async open({ dbPath, legacyJsonPath }) {
		await mkdir(dirname(dbPath), { recursive: true });
		const database = new DatabaseSync(dbPath);
		try {
			createSchema(database);
			const store = new MediaStore(database, dbPath);
			await store.migrateLegacyJson(legacyJsonPath);
			return store;
		} catch (error) {
			database.close();
			throw error;
		}
	}

	constructor(database, dbPath) {
		this.database = database;
		this.dbPath = dbPath;
		this.statements = createStatements(database);
	}

	async migrateLegacyJson(legacyJsonPath) {
		if (!legacyJsonPath || this.statements.getMeta.get('legacy_json_migrated')) return;
		let items = [];
		try {
			const parsed = JSON.parse(await readFile(legacyJsonPath, 'utf8'));
			if (!Array.isArray(parsed)) throw new Error('旧图库 JSON 必须是数组');
			items = parsed;
		} catch (error) {
			// Leave migration pending so a subsequently restored file can be imported.
			if (error.code === 'ENOENT') return;
			throw error;
		}

		if (Number(this.statements.count.get().count) === 0 && items.length) {
			this.replace(items);
		}
		this.statements.setMeta.run('legacy_json_migrated', new Date().toISOString());
	}

	list(collection) {
		const rows = collection
			? this.statements.listCollection.all(collection === 'photos' ? 'photos' : 'blog')
			: this.statements.list.all();
		return rows.map(fromRow);
	}

	findReusable(hash, collection, pipelineVersion) {
		const row = this.statements.findReusable.get(hash, collection === 'photos' ? 'photos' : 'blog', pipelineVersion);
		return row ? fromRow(row) : null;
	}

	upsert(item) {
		const row = toRow(item);
		const conflictKey = { url: row.url, hash: row.hash, collection: row.collection };
		this.database.exec('BEGIN IMMEDIATE');
		try {
			const replaced = this.statements.findConflicts.all(conflictKey).map(fromRow);
			this.statements.deleteConflicts.run(conflictKey);
			this.statements.insert.run(row);
			this.database.exec('COMMIT');
			return replaced;
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
	}

	rollbackUpsert(itemId, replacedItems) {
		this.database.exec('BEGIN IMMEDIATE');
		try {
			this.statements.deleteById.run(itemId);
			for (const item of replacedItems) this.statements.insert.run(toRow(item));
			this.database.exec('COMMIT');
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
	}

	replace(items) {
		this.database.exec('BEGIN IMMEDIATE');
		try {
			this.database.exec('DELETE FROM media_items');
			for (const item of items) this.statements.insert.run(toRow(item));
			this.database.exec('COMMIT');
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
	}

	async backup(destination) {
		await mkdir(dirname(destination), { recursive: true });
		await backupDatabase(this.database, destination);
	}

	close() {
		this.database.close();
	}
}

export const readMediaItemsSync = ({ dbPath, legacyJsonPath, collection }) => {
	if (existsSync(dbPath)) {
		const database = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const statement = collection
				? database.prepare('SELECT * FROM media_items WHERE collection = ? ORDER BY created_at DESC')
				: database.prepare('SELECT * FROM media_items ORDER BY created_at DESC');
			const rows = collection ? statement.all(collection) : statement.all();
			return rows.map(fromRow);
		} finally {
			database.close();
		}
	}

	if (!existsSync(legacyJsonPath)) return [];
	const items = JSON.parse(readFileSync(legacyJsonPath, 'utf8'));
	if (!Array.isArray(items)) throw new Error('旧图库 JSON 必须是数组');
	return items.filter((item) => !collection || item.collection === collection);
};
