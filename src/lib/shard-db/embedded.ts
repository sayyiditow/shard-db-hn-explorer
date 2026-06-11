import ShardDb from 'shard-db';
import type { ShardDbError } from './client';
import type { QueryBody } from './query-types';

/** Minimal contract of the native ShardDb object — used for unit-test injection.
 *  The native binding always receives raw JSON strings (object serialisation
 *  happens in EmbeddedShardDbClient.query before this is called). */
export interface INativeShardDb {
	query(json: string): string;
	close(): void;
}

export class EmbeddedShardDbClient {
	private db: INativeShardDb;

	/**
	 * @param dbRoot   Absolute path to the shard-db data directory.
	 * @param _native  Inject a fake native object for unit tests; omit in production.
	 */
	constructor(dbRoot: string, _native?: INativeShardDb) {
		this.db = _native ?? new ShardDb(dbRoot);
	}

	async query<T = unknown>(body: QueryBody): Promise<T | ShardDbError> {
		const raw = this.db.query(JSON.stringify(body));
		return JSON.parse(raw) as T | ShardDbError;
	}

	close(): void {
		this.db.close();
	}
}
