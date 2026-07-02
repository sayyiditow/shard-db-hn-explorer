/** SvelteKit server hook — kicks off the HN refresh loop on the
 *  first incoming request.  SvelteKit has no dedicated server-boot
 *  hook; lazy-init from `handle` is the idiomatic placement.
 *
 *  start() is idempotent (module-level flag), so repeated requests
 *  during a hot-reloaded dev session won't schedule duplicate
 *  intervals.  Production / `bun build` doesn't hot-reload anyway. */

import type { Handle } from '@sveltejs/kit';
import { start } from '$lib/refresh-cache';
import { closeShardDb } from '$lib/shard-db/client';

const shutdown = () => { closeShardDb(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

let started = false;

export const handle: Handle = async ({ event, resolve }) => {
    if (!started) {
        started = true;
        start();
    }
    return resolve(event);
};
