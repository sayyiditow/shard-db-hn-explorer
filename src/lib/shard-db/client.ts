import type { QueryBody } from './query-types';
import { EmbeddedShardDbClient } from './embedded';

export interface ShardDbError {
	error: string;
}

export interface IShardDbClient {
	query<T = unknown>(body: QueryBody): Promise<T | ShardDbError>;
	close(): void;
}

let _shardDb: IShardDbClient;

function getShardDb(): IShardDbClient {
	if (!_shardDb) {
		_shardDb = new EmbeddedShardDbClient(
			process.env.SHARD_DB_ROOT
				?? (() => { throw new Error('SHARD_DB_ROOT must be set'); })()
		);
	}
	return _shardDb;
}

export const shardDb: IShardDbClient = new Proxy({} as IShardDbClient, {
	get(_target, prop: keyof IShardDbClient) {
		const client = getShardDb();
		const val = client[prop];
		return typeof val === 'function' ? val.bind(client) : val;
	},
});

export function isError(resp: unknown): resp is ShardDbError {
	return typeof resp === 'object' && resp !== null && 'error' in resp;
}

export function closeShardDb(): void {
	if (_shardDb) _shardDb.close();
}
