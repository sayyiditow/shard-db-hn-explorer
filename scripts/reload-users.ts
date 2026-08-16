#!/usr/bin/env bun
/**
 * Reload just hn/users from the Hugging Face snapshot, without touching
 * stories/comments or the refresh-cache state.
 *
 *
 * Run:
 *   bun run scripts/reload-users.ts
 */

import { shardDb } from '../src/lib/shard-db/client';
import { dropIndexes, truncate, loadUsers, addIndexes } from './lib/bulk-ops';

async function main() {
	console.log(`Reload hn/users — shard-db root: ${process.env.SHARD_DB_ROOT ?? '(not set)'}`);

	console.log('\nDropping indexes:');
	await dropIndexes('users');

	console.log('\nTruncating existing data:');
	await truncate('users');

	const stats = await loadUsers();

	console.log('\nBuilding indexes:');
	await addIndexes('users');

	console.log('\nDone.');
	console.log(`  Users: ${stats.inserted.toLocaleString()} inserted, ${stats.dropped.toLocaleString()} dropped`);

	shardDb.close();
}

main().catch((err) => {
	console.error('\nreload-users failed:', err);
	process.exit(1);
});
