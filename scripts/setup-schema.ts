#!/usr/bin/env bun
/**
 * Create the three HN objects in shard-db.
 *
 * Idempotent: re-running on an existing DB only re-adds the dir
 * and reports "already exists" for objects; never wipes data.
 *
 * Run: bun run scripts/setup-schema.ts
 */

import { shardDb as client, isError } from '../src/lib/shard-db/client';
import type { QueryBody } from '../src/lib/shard-db/query-types';
import { INDEX_LISTS } from './lib/hn-schema';

const DIR = 'hn';

async function step(label: string, body: QueryBody) {
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
	console.log(`shard-db root: ${process.env.SHARD_DB_ROOT ?? '(not set)'}`);
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
			'url:varchar:512',                                  // ~99% of HN URLs fit incl. tracking params; longer get truncated with "..."
			'title:varchar:128',                                // HN enforces ~80-char titles; 128 is safe upper bound
			'text:varchar:4096',                                // self-post body (Ask HN, polls). 4 KB covers ~99%; longer get truncated with "..."
			'descendants:int',
			'type:enum(story,job,poll,comment,pollopt)',        // 1-byte stored, auto-bitmap (was varchar:8)
			'deleted:bool',                                     // auto-bitmap
			'dead:bool'                                         // auto-bitmap
		],
		// title:trigram for substring search on /search; planner picks btree-leaf
		// for short patterns and trigram for longer (>= 6 chars). dead/deleted
		// auto-bitmap by being bool fields. type auto-bitmap by being enum.
		// Index list comes from scripts/lib/hn-schema.ts — single source of
		// truth shared with bulk-load.ts's load-then-index pattern.
		indexes: INDEX_LISTS.stories
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
			'text:varchar:4096',                                // 4 KB covers ~95% of HN comments; longer get truncated with "..."
			'deleted:bool',                                     // auto-bitmap
			'dead:bool'                                         // auto-bitmap
		],
		// No trigram on comment text — at 30M-comment scale the .tg files
		// would exceed 100 GB. Comment search is "comments by X" (by:btree)
		// or "comments on story Y" (story_root:btree); full-text comment
		// search is out of scope for shard-db's positioning.
		indexes: INDEX_LISTS.comments
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
			'about:varchar:1024',                               // most HN bios are short; longer get truncated with "..."
			'submitted_count:int'
		],
		indexes: INDEX_LISTS.users
	});

	console.log('\nSchema ready.');
}

main()
	.then(() => {
		client.close();
	})
	.catch((err) => {
		console.error(err);
		client.close();
		process.exit(1);
	});
