/**
 * shard-db Bun client — talks the JSON-over-TCP wire protocol.
 *
 * Wire framing: client sends one JSON request terminated by `\n`.
 * Server responds with one JSON document terminated by `\0\n`.
 * That trailing-NUL framing is what shard-db's docs/query-protocol/overview.md
 * specifies; respect it for partial-read robustness.
 *
 * Per-connection model: one socket, one in-flight request, sequential.
 * For higher throughput (e.g. bulk ingest), open multiple clients in
 * parallel — the protocol is single-threaded per-connection but the
 * server handles concurrent connections via its own worker pool.
 */

import net from 'node:net';

export interface ShardDbClientOptions {
	host?: string;
	port?: number;
	token?: string;
	/** Per-request connect+IO timeout in ms. 0 = no timeout. */
	timeoutMs?: number;
}

export interface ShardDbError {
	error: string;
}

export class ShardDbClient {
	private host: string;
	private port: number;
	private token?: string;
	private timeoutMs: number;

	constructor(opts: ShardDbClientOptions = {}) {
		this.host = opts.host ?? '127.0.0.1';
		this.port = opts.port ?? 9199;
		this.token = opts.token;
		this.timeoutMs = opts.timeoutMs ?? 30_000;
	}

	/**
	 * Send one JSON request, await one response.
	 *
	 * The request body is augmented with `token` if the client was
	 * constructed with one. Returns the parsed response on success or
	 * `{ error: "..." }` on any failure mode (connection refused,
	 * timeout, malformed JSON, or shard-db error response). Callers
	 * always check `isError(resp)` and never need try/catch.
	 */
	async query<T = unknown>(body: Record<string, unknown>): Promise<T | ShardDbError> {
		const payload = JSON.stringify(this.token ? { ...body, token: this.token } : body);

		return new Promise((resolve) => {
			const socket = net.createConnection({ host: this.host, port: this.port });
			let buf = '';
			let settled = false;

			const settle = (value: T | ShardDbError) => {
				if (settled) return;
				settled = true;
				socket.destroy();
				resolve(value);
			};

			const timer =
				this.timeoutMs > 0
					? setTimeout(
							() => settle({ error: `shard-db timeout after ${this.timeoutMs}ms` }),
							this.timeoutMs
					  )
					: null;

			socket.on('connect', () => {
				socket.write(payload + '\n');
			});

			socket.on('data', (chunk) => {
				buf += chunk.toString('utf8');
				// Framing: response terminates with \0\n.
				const term = buf.indexOf('\0\n');
				if (term === -1) return;
				const json = buf.slice(0, term);
				if (timer) clearTimeout(timer);
				try {
					const parsed = JSON.parse(json) as T | ShardDbError;
					settle(parsed);
				} catch (err) {
					settle({ error: `bad response from shard-db: ${err instanceof Error ? err.message : String(err)}` });
				}
			});

			socket.on('error', (err) => {
				if (timer) clearTimeout(timer);
				const msg = (err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
					? `cannot reach shard-db at ${this.host}:${this.port} — is the daemon running?`
					: err.message;
				settle({ error: msg });
			});

			socket.on('close', () => {
				if (timer) clearTimeout(timer);
				settle({ error: 'shard-db closed connection before response' });
			});
		});
	}
}

/** Default singleton; reads HOST / PORT / TOKEN from env for prod. */
export const shardDb = new ShardDbClient({
	host: process.env.SHARD_DB_HOST,
	port: process.env.SHARD_DB_PORT ? Number(process.env.SHARD_DB_PORT) : undefined,
	token: process.env.SHARD_DB_TOKEN
});

export function isError(resp: unknown): resp is ShardDbError {
	return typeof resp === 'object' && resp !== null && 'error' in resp;
}
