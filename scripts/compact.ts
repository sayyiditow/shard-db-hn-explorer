#!/usr/bin/env bun
/**
 * Compact all HN objects — rewrites segment files to trim trailing zero
 * fields, reclaiming disk space from records written before 2026.06.4.
 *
 * Run: bun run scripts/compact.ts
 */

import { shardDb as client, isError } from '../src/lib/shard-db/client';

const DIR = 'hn';
const OBJECTS = ['stories', 'comments', 'users'];

for (const object of OBJECTS) {
	process.stdout.write(`  compact ${DIR}/${object} ... `);
	const resp = await client.query({ mode: 'compact', dir: DIR, object });
	if (isError(resp)) {
		console.log(`FAILED: ${resp.error}`);
	} else {
		console.log('ok');
	}
}

client.close();
