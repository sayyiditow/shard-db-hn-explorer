/** SvelteKit server hook — kicks off the HN refresh loop on the
 *  first incoming request.  SvelteKit has no dedicated server-boot
 *  hook; lazy-init from `handle` is the idiomatic placement.
 *
 *  start() is idempotent (module-level flag), so repeated requests
 *  during a hot-reloaded dev session won't schedule duplicate
 *  intervals.  Production / `bun build` doesn't hot-reload anyway.
 *
 *  The top-level await below runs before any of that: adapter-node's
 *  generated index.js statically imports this module (via handler.js)
 *  before it ever calls httpServer.listen(), so this await blocks the
 *  process from accepting a single connection until it resolves. That
 *  serially cold-opens stories/comments/users via one cheap `count`
 *  each — on a fresh restart, with nothing else able to reach shard-db
 *  yet, there's no other caller to race the open against. Without
 *  this, the refresh tick's own background work and every
 *  simultaneously-arriving request would race shard-db's internal
 *  per-object cold-open at once, and query latency balloons to
 *  minutes (see the 2026-07-03 hn-explorer prod incident). */

import type { Handle } from '@sveltejs/kit';
import { start } from '$lib/refresh-cache';
import { closeShardDb, primeCoreObjects } from '$lib/shard-db/client';

const shutdown = () => { closeShardDb(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

await primeCoreObjects();

let started = false;

export const handle: Handle = async ({ event, resolve }) => {
    if (!started) {
        started = true;
        start();
    }
    return resolve(event);
};
