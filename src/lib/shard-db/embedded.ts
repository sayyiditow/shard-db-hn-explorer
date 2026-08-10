import ShardDb from 'shard-db';
import type { ShardDbError } from './client';
import type { QueryBody } from './query-types';

/** Minimal contract of the native ShardDb object — used for unit-test injection.
 *  The native binding always receives raw JSON strings (object serialisation
 *  happens in EmbeddedShardDbClient.query before this is called). */
export interface INativeShardDb {
	query(json: string): unknown;
	close(): void;
	setLogHandler?(fn: ((type: number, msg: string) => void) | null): void;
}

const WRITE_MODES = new Set([
	'insert',
	'update',
	'bulk-insert',
	'bulk-update',
	'bulk-insert-delimited',
	'bulk-update-delimited'
]);

function removeNul(value: unknown): unknown {
	if (typeof value === 'string') return value.replaceAll('\u0000', '');
	if (Array.isArray(value)) return value.map(removeNul);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [
				key.replaceAll('\u0000', ''),
				removeNul(nested)
			])
		);
	}
	return value;
}

// 1=error 2=warn 3=info 4=debug 5=audit 6=slow
export class EmbeddedShardDbClient {
	private db: INativeShardDb;

	/**
	 * @param dbRoot   Absolute path to the shard-db data directory.
	 * @param _native  Inject a fake native object for unit tests; omit in production.
	 */
	constructor(dbRoot: string, _native?: INativeShardDb) {
		this.db = _native ?? new ShardDb(dbRoot);
		this.db.setLogHandler?.((type, msg) => {
			const text = msg.trimEnd();
			if (type === 1) console.error(text);
			else if (type === 2 || type === 6) console.warn(text);
			else console.log(text);
		});
	}

	async query<T = unknown>(body: QueryBody): Promise<T | ShardDbError> {
		const safeBody = WRITE_MODES.has(body.mode)
			? removeNul(body) as QueryBody
			: body;
		const raw = await this.db.query(JSON.stringify(safeBody));
		return typeof raw === 'string' ? JSON.parse(raw) as T | ShardDbError : raw as T | ShardDbError;
	}

	close(): void {
		this.db.close();
	}
}
