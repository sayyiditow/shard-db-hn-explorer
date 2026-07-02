/** Debug query proxy — passes arbitrary shard-db JSON queries through the
 *  embedded client.  Localhost-only: rejects any request whose client
 *  address is not 127.0.0.1 / ::1.  No token needed because it is
 *  unreachable from outside the server.
 *
 *  Usage (from the server via SSH):
 *    curl -s -X POST http://localhost:3000/api/debug \
 *      -H 'Content-Type: application/json' \
 *      -d '{"mode":"count","dir":"hn","object":"stories"}'
 *
 *  Reindex title trigram (safe while app is running — takes wrlock briefly):
 *    curl -s -X POST http://localhost:3000/api/debug \
 *      -H 'Content-Type: application/json' \
 *      -d '{"mode":"add-index","dir":"hn","object":"stories","field":"title:trigram","force":true}'
 */

import { json, type RequestHandler } from '@sveltejs/kit';
import { shardDb } from '$lib/shard-db/client';

const LOCALHOST = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const POST: RequestHandler = async (event) => {
	const addr = event.getClientAddress();
	if (!LOCALHOST.has(addr)) {
		return json({ error: 'debug endpoint is localhost-only' }, { status: 403 });
	}

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const result = await shardDb.query(body as Parameters<typeof shardDb.query>[0]);
	return json(result);
};
