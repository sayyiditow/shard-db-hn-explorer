import { describe, test, expect } from 'bun:test';
import { EmbeddedShardDbClient } from './embedded';
import type { INativeShardDb } from './embedded';
import { isError } from './client';

function makeFakeNative(responses: Record<string, unknown>): {
	native: INativeShardDb;
	calls: string[];
} {
	const calls: string[] = [];
	const native: INativeShardDb = {
		query(json: string): unknown {
			calls.push(json);
			const body = JSON.parse(json) as Record<string, unknown>;
			const resp = responses[body.mode as string] ?? { ok: true };
			return JSON.stringify(resp);
		},
		close() { calls.push('__close__'); }
	};
	return { native, calls };
}

describe('EmbeddedShardDbClient', () => {
	test('query() serializes QueryBody to JSON and parses the response', async () => {
		const { native } = makeFakeNative({ get: { title: 'hello' } });
		const client = new EmbeddedShardDbClient('', native);

		const result = await client.query({ mode: 'get', dir: 'hn', object: 'stories', key: '1' });

		expect(result).toEqual({ title: 'hello' });
	});

	test('removes NULs recursively from write queries', async () => {
		const { native, calls } = makeFakeNative({ insert: {} });
		const client = new EmbeddedShardDbClient('', native);

		await client.query({
			mode: 'insert',
			dir: 'hn',
			object: 'stories',
			key: '12\u000034',
			value: {
				title: 'hello\u0000world',
				tags: ['a\u0000b', { nested: 'x\u0000y' }],
				newline: 'keep\nthis'
			}
		});

		expect(JSON.parse(calls[0])).toEqual({
			mode: 'insert',
			dir: 'hn',
			object: 'stories',
			key: '1234',
			value: {
				title: 'helloworld',
				tags: ['ab', { nested: 'xy' }],
				newline: 'keep\nthis'
			}
		});
	});

	test('sanitizes bulk record keys and values', async () => {
		const { native, calls } = makeFakeNative({ 'bulk-insert': {} });
		const client = new EmbeddedShardDbClient('', native);

		await client.query({
			mode: 'bulk-insert',
			dir: 'hn',
			object: 'users',
			records: {
				['user\u00001']: { about: 'bio\u0000text' }
			}
		});

		expect(JSON.parse(calls[0]).records).toEqual({
			user1: { about: 'biotext' }
		});
	});

	test('leaves read queries unchanged', async () => {
		const { native, calls } = makeFakeNative({ find: {} });
		const client = new EmbeddedShardDbClient('', native);

		await client.query({
			mode: 'find',
			dir: 'hn',
			object: 'stories',
			criteria: [{ field: 'title', op: 'contains', value: 'a\u0000b' }]
		});

		expect(JSON.parse(calls[0]).criteria[0].value).toBe('a\u0000b');
	});

	test('query() passes all body fields to native.query() as JSON', async () => {
		const { native, calls } = makeFakeNative({});
		const client = new EmbeddedShardDbClient('', native);

		await client.query({ mode: 'count', dir: 'hn', object: 'stories' });

		expect(calls).toHaveLength(1);
		const sent = JSON.parse(calls[0]) as Record<string, unknown>;
		expect(sent.mode).toBe('count');
		expect(sent.dir).toBe('hn');
		expect(sent.object).toBe('stories');
	});

	test('query() returns shard-db error objects without throwing', async () => {
		const { native } = makeFakeNative({ get: { error: 'missing key' } });
		const client = new EmbeddedShardDbClient('', native);

		const result = await client.query({ mode: 'get', dir: 'hn', object: 'stories', key: 'x' });

		expect(isError(result)).toBe(true);
		expect((result as { error: string }).error).toBe('missing key');
	});

	test('close() delegates to native.close()', () => {
		const { native, calls } = makeFakeNative({});
		const client = new EmbeddedShardDbClient('', native);

		client.close();

		expect(calls).toContain('__close__');
	});
});
