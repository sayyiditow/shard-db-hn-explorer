#!/usr/bin/env bun
/**
 * Sample-data loader for local dev. Fetches 10K recent items from
 * the HN Firebase API and bulk-inserts them into shard-db.
 *
 * This is NOT the full bulk-load story — that comes via the Hugging
 * Face snapshot (see scripts/bulk-load.ts when written). This script
 * exists to let a developer go from `bun install` to a usable DB in
 * under a minute with a sensible mix of stories + comments + users.
 *
 * Run: bun run scripts/sample-load.ts
 */

import { ShardDbClient, isError } from '../src/lib/shard-db/client';

const client = new ShardDbClient({
	host: process.env.SHARD_DB_HOST ?? '127.0.0.1',
	port: process.env.SHARD_DB_PORT ? Number(process.env.SHARD_DB_PORT) : 9199,
	token: process.env.SHARD_DB_TOKEN
});

const HN_BASE = 'https://hacker-news.firebaseio.com/v0';
const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE ?? 10_000);
const FETCH_CONCURRENCY = 20;
const BULK_CHUNK = 1000;

interface HnItem {
	id: number;
	by?: string;
	time?: number;
	type?: 'story' | 'job' | 'comment' | 'poll' | 'pollopt';
	title?: string;
	url?: string;
	score?: number;
	descendants?: number;
	text?: string;
	parent?: number;
	kids?: number[];
	deleted?: boolean;
	dead?: boolean;
}

interface HnUser {
	id: string;
	karma?: number;
	created?: number;
	about?: string;
	submitted?: number[];
}

async function fetchJSON<T>(url: string): Promise<T | null> {
	try {
		const r = await fetch(url);
		if (!r.ok) return null;
		return (await r.json()) as T;
	} catch {
		return null;
	}
}

async function pool<T, U>(items: T[], concurrency: number, fn: (item: T) => Promise<U>): Promise<U[]> {
	const out: U[] = new Array(items.length);
	let i = 0;
	const workers = Array.from({ length: concurrency }, async () => {
		while (true) {
			const idx = i++;
			if (idx >= items.length) return;
			out[idx] = await fn(items[idx]);
		}
	});
	await Promise.all(workers);
	return out;
}

function findStoryRoot(item: HnItem, all: Map<number, HnItem>): number {
	let cur: HnItem | undefined = item;
	while (cur?.parent) {
		const parent = all.get(cur.parent);
		if (!parent) return cur.parent;
		cur = parent;
	}
	return cur?.id ?? item.id;
}

async function main() {
	console.log(`Sample-load: pulling ${SAMPLE_SIZE} recent items from HN Firebase API`);

	const maxItem = await fetchJSON<number>(`${HN_BASE}/maxitem.json`);
	if (!maxItem) {
		console.error('Failed to fetch maxitem.json');
		process.exit(1);
	}
	console.log(`  maxitem = ${maxItem}, fetching range [${maxItem - SAMPLE_SIZE}, ${maxItem}]`);

	const ids = Array.from({ length: SAMPLE_SIZE }, (_, k) => maxItem - SAMPLE_SIZE + k + 1);

	process.stdout.write('  Fetching items ... ');
	const fetched = await pool(ids, FETCH_CONCURRENCY, (id) =>
		fetchJSON<HnItem>(`${HN_BASE}/item/${id}.json`)
	);
	const items = fetched.filter((x): x is HnItem => x !== null);
	console.log(`got ${items.length}`);

	// Index for story-root resolution
	const byId = new Map<number, HnItem>();
	for (const it of items) byId.set(it.id, it);

	const stories: HnItem[] = [];
	const comments: HnItem[] = [];
	const userSet = new Set<string>();
	for (const it of items) {
		if (it.by) userSet.add(it.by);
		if (it.type === 'story' || it.type === 'job' || it.type === 'poll' || it.type === 'pollopt') {
			stories.push(it);
		} else if (it.type === 'comment') {
			comments.push(it);
		}
	}
	console.log(`  Split: ${stories.length} stories/jobs/polls, ${comments.length} comments, ${userSet.size} unique users`);

	// Bulk-insert helper
	async function bulkInsert(object: string, records: { key: string; value: Record<string, unknown> }[]) {
		for (let off = 0; off < records.length; off += BULK_CHUNK) {
			const chunk = records.slice(off, off + BULK_CHUNK);
			const resp = await client.query({
				mode: 'bulk-insert',
				dir: 'hn',
				object,
				records: chunk
			});
			if (isError(resp)) {
				console.error(`bulk-insert ${object} failed at offset ${off}: ${resp.error}`);
				process.exit(1);
			}
		}
	}

	// HN's Firebase API returns timestamps in Unix seconds; the schema
	// uses `timestamp` (Unix milliseconds), so we multiply by 1000 on
	// the way in. shard-db stores int64 — no overflow risk.
	const toMs = (sec: number | undefined): number => (sec ? sec * 1000 : 0);

	// Stories
	process.stdout.write(`  Inserting stories (${stories.length}) ... `);
	await bulkInsert(
		'stories',
		stories.map((s) => ({
			key: String(s.id),
			value: {
				by: s.by ?? '',
				time: toMs(s.time),
				score: s.score ?? 0,
				url: s.url ?? '',
				title: s.title ?? '',
				descendants: s.descendants ?? 0,
				type: s.type ?? 'story',
				deleted: s.deleted ?? false,
				dead: s.dead ?? false
			}
		}))
	);
	console.log('ok');

	// Comments
	process.stdout.write(`  Inserting comments (${comments.length}) ... `);
	await bulkInsert(
		'comments',
		comments.map((c) => ({
			key: String(c.id),
			value: {
				by: c.by ?? '',
				time: toMs(c.time),
				parent: c.parent ?? 0,
				story_root: findStoryRoot(c, byId),
				text: c.text ?? '',
				deleted: c.deleted ?? false,
				dead: c.dead ?? false
			}
		}))
	);
	console.log('ok');

	// Users — fetch their profiles
	process.stdout.write(`  Fetching ${userSet.size} user profiles ... `);
	const userIds = [...userSet];
	const userProfiles = await pool(userIds, FETCH_CONCURRENCY, (u) =>
		fetchJSON<HnUser>(`${HN_BASE}/user/${u}.json`)
	);
	const users = userProfiles.filter((u): u is HnUser => u !== null);
	console.log(`got ${users.length}`);

	process.stdout.write(`  Inserting users (${users.length}) ... `);
	await bulkInsert(
		'users',
		users.map((u) => ({
			key: u.id,
			value: {
				karma: u.karma ?? 0,
				created: toMs(u.created),
				about: u.about ?? '',
				submitted_count: u.submitted?.length ?? 0
			}
		}))
	);
	console.log('ok');

	console.log('\nSample data loaded. Try:');
	console.log('  bun run dev');
	console.log('  curl -s http://localhost:5173/api/count');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
