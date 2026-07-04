import { describe, test, expect } from 'bun:test';
import { fetchLiveCommentCounts, applyLiveCommentCounts } from './comment-counts';
import type { QueryBody } from '$lib/shard-db/query-types';

describe('fetchLiveCommentCounts', () => {
	test('returns an empty Map without querying when storyIds is empty', async () => {
		let called = false;
		const counts = await fetchLiveCommentCounts([], {
			query: async () => { called = true; return []; }
		});
		expect(counts).toEqual(new Map());
		expect(called).toBe(false);
	});

	test('returns an empty Map without querying when no id is numeric', async () => {
		let called = false;
		const counts = await fetchLiveCommentCounts(['not-a-number', 'also-nope'], {
			query: async () => { called = true; return []; }
		});
		expect(counts).toEqual(new Map());
		expect(called).toBe(false);
	});

	test('maps story_root rows to counts, keyed by string id', async () => {
		const counts = await fetchLiveCommentCounts(['1', '2', '3'], {
			query: async () => [
				{ story_root: 1, n: 5 },
				{ story_root: 3, n: 0 }
			]
		});
		expect(counts).toEqual(new Map([['1', 5], ['3', 0]]));
		// story 2 legitimately absent — zero comments, not "unknown".
		expect(counts?.has('2')).toBe(false);
	});

	test('returns null on a query error response', async () => {
		const counts = await fetchLiveCommentCounts(['1'], {
			query: async () => ({ error: 'timeout' })
		});
		expect(counts).toBeNull();
	});

	test('returns null when response is not an array', async () => {
		const counts = await fetchLiveCommentCounts(['1'], {
			query: async () => ({ unexpected: 'shape' })
		});
		expect(counts).toBeNull();
	});

	test('passes an aggregate query grouped on story_root with an in-criteria on the numeric ids', async () => {
		let seen: QueryBody | null = null;
		await fetchLiveCommentCounts(['10', '20'], {
			query: async (q) => { seen = q; return []; }
		});
		expect(seen).toMatchObject({
			mode: 'aggregate',
			dir: 'hn',
			object: 'comments',
			group_by: ['story_root'],
			aggregates: [{ fn: 'count', alias: 'n' }],
			criteria: [{ field: 'story_root', op: 'in', value: [10, 20] }]
		});
	});
});

describe('applyLiveCommentCounts', () => {
	test('returns input unchanged for an empty array', async () => {
		const out = await applyLiveCommentCounts([]);
		expect(out).toEqual([]);
	});

	test('overwrites descendants with live counts, defaulting absent ids to 0', async () => {
		const stories = [
			{ key: '1', descendants: 99 },
			{ key: '2', descendants: 42 }
		];
		const out = await applyLiveCommentCounts(stories, {
			query: async () => [{ story_root: 1, n: 7 }]
		});
		expect(out).toEqual([
			{ key: '1', descendants: 7 },
			{ key: '2', descendants: 0 }
		]);
	});

	test('returns stories unmodified when the aggregate query fails', async () => {
		const stories = [{ key: '1', descendants: 99 }];
		const out = await applyLiveCommentCounts(stories, {
			query: async () => ({ error: 'timeout' })
		});
		expect(out).toEqual(stories);
	});
});
