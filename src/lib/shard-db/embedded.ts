import ShardDb from 'shard-db';
import type { ShardDbError } from './client';
import type { QueryBody } from './query-types';

/** Minimal contract of the native ShardDb object — used for unit-test injection.
 *  The native binding always receives raw JSON strings (object serialisation
 *  happens in EmbeddedShardDbClient.query before this is called). */
export interface INativeShardDb {
	query(json: string): unknown;
	close(): void;
	setLogHandler?(fn: ((type: string, msg: string) => void) | null): void;
}

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
			if (type === 'error') console.error(text);
			else if (type === 'warn' || type === 'slow') console.warn(text);
			else console.log(text);
		});
	}

	async query<T = unknown>(body: QueryBody): Promise<T | ShardDbError> {
		const raw = await this.db.query(JSON.stringify(body));
		return typeof raw === 'string' ? JSON.parse(raw) as T | ShardDbError : raw as T | ShardDbError;
	}

	close(): void {
		this.db.close();
	}
}
