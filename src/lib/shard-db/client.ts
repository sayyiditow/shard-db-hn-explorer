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

const HN_DIR = 'hn';
const CORE_OBJECTS = ['stories', 'comments', 'users'] as const;

/** Serially opens each core object via a cheap `count` query, one at a
 *  time, before the server accepts any traffic (called via top-level
 *  await in hooks.server.ts). shard-db's per-object cold-open
 *  (`slotcask_open`) fans out its own internal parallel work across a
 *  shared thread pool; when many callers cold-open the same objects
 *  concurrently — the refresh tick and every simultaneously-arriving
 *  request — those internal fan-outs pile up on each other and
 *  request latency balloons to minutes. Priming here means every
 *  object is already open by the time anything else can touch it, so
 *  there's nothing left to race. */
export async function primeCoreObjects(): Promise<void> {
	for (const object of CORE_OBJECTS) {
		const r = await shardDb.query({ mode: 'count', dir: HN_DIR, object });
		if (isError(r)) {
			console.error(`prime: count failed for ${object}: ${(r as ShardDbError).error}`);
		}
	}
}
