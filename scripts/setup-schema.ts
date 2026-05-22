#!/usr/bin/env bun
/**
 * Create the three HN objects in shard-db.
 *
 * Idempotent: re-running on an existing DB only re-adds the dir
 * and reports "already exists" for objects; never wipes data.
 *
 * Run: bun run scripts/setup-schema.ts
 */

import { ShardDbClient, isError } from '../src/lib/shard-db/client';

const client = new ShardDbClient({
	host: process.env.SHARD_DB_HOST ?? '127.0.0.1',
	port: process.env.SHARD_DB_PORT ? Number(process.env.SHARD_DB_PORT) : 9199,
	token: process.env.SHARD_DB_TOKEN
});

const DIR = 'hn';

async function step(label: string, body: Record<string, unknown>) {
	process.stdout.write(`  ${label} ... `);
	const resp = await client.query(body);
	if (isError(resp)) {
		// "already exists" is fine on re-runs
		if (resp.error.toLowerCase().includes('exist')) {
			process.stdout.write('already exists ✓\n');
			return;
		}
		console.log(`FAILED: ${resp.error}`);
		process.exit(1);
	}
	process.stdout.write('ok ✓\n');
}

async function main() {
	console.log(`Connecting to shard-db at ${process.env.SHARD_DB_HOST ?? '127.0.0.1'}:${process.env.SHARD_DB_PORT ?? 9199}`);
	console.log('');

	await step('add-dir hn', { mode: 'add-dir', dir: DIR });

	console.log('\nCreating objects:');

	await step('stories', {
		mode: 'create-object',
		dir: DIR,
		object: 'stories',
		splits: 64,
		max_key: 12,
		fields: [
			'by:varchar:32',
			'time:timestamp',                                   // HN epoch seconds * 1000 = ms
			'score:int',
			'url:varchar:2048',                                 // bumped from 512 — HN URLs with tracking params
			'title:varchar:512',
			'text:varchar:32768',                               // self-post body (Ask HN, polls). Empty for link-only stories.
			'descendants:int',
			'type:enum(story,job,poll,comment,pollopt)',        // 1-byte stored, auto-bitmap (was varchar:8)
			'deleted:bool',                                     // auto-bitmap
			'dead:bool'                                         // auto-bitmap
		],
		// title:trigram for substring search on /search; planner picks btree-leaf
		// for short patterns and trigram for longer (>= 6 chars). dead/deleted
		// auto-bitmap by being bool fields. type auto-bitmap by being enum.
		indexes: [
			'by',
			'time',
			'score',
			'type',
			'dead',
			'deleted',
			'title:trigram',
			'by+time',
			'time+score',
			'type+time'
		]
	});

	await step('comments', {
		mode: 'create-object',
		dir: DIR,
		object: 'comments',
		splits: 256,
		max_key: 12,
		fields: [
			'by:varchar:32',
			'time:timestamp',                                   // ms; converted from HN seconds at insert
			'parent:int',
			'story_root:int',
			'text:varchar:32768',                               // bumped from 8192 — long-form HN comments do exist
			'deleted:bool',                                     // auto-bitmap
			'dead:bool'                                         // auto-bitmap
		],
		// No trigram on comment text — at 30M-comment scale the .tg files
		// would exceed 100 GB. Comment search is "comments by X" (by:btree)
		// or "comments on story Y" (story_root:btree); full-text comment
		// search is out of scope for shard-db's positioning.
		indexes: [
			'by',
			'time',
			'parent',
			'story_root',
			'dead',
			'deleted',
			'by+time',
			'story_root+time'
		]
	});

	await step('users', {
		mode: 'create-object',
		dir: DIR,
		object: 'users',
		splits: 32,
		max_key: 32,
		fields: [
			'karma:int',
			'created:timestamp',        // ms; converted from HN seconds at insert
			'about:varchar:4096',
			'submitted_count:int'
		],
		indexes: ['karma', 'created']
	});

	console.log('\nSchema ready.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
