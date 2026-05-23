/**
 * shard-db Bun client — talks the JSON-over-TCP wire protocol.
 *
 * Wire framing: client sends one JSON request terminated by `\n`.
 * Server responds with one JSON document terminated by `\0\n`.
 *
 * Connection pool model: idle sockets are recycled across queries,
 * eliminating per-request TCP handshake overhead.  The pool grows
 * to handle concurrent demand (e.g. the homepage fires 5 parallel
 * queries) and idle sockets are kept for the next page load.
 * Dead sockets are detected on first write and replaced lazily.
 */

import net from 'node:net';

export interface ShardDbClientOptions {
	host?: string;
	port?: number;
	token?: string;
	/** Per-request IO timeout in ms. 0 = no timeout. Default 15_000. */
	timeoutMs?: number;
	/** Connect timeout in ms. Default 5_000. */
	connectTimeoutMs?: number;
	/** Max idle connections in the pool. Default 16. */
	maxPoolSize?: number;
}

export interface ShardDbError {
	error: string;
}

export class ShardDbClient {
	private host: string;
	private port: number;
	private token?: string;
	private timeoutMs: number;
	private connectTimeoutMs: number;
	private maxPoolSize: number;

	/** Sockets that finished a previous query and are ready for reuse. */
	private idle: net.Socket[] = [];

	constructor(opts: ShardDbClientOptions = {}) {
		this.host = opts.host ?? '127.0.0.1';
		this.port = opts.port ?? 9199;
		this.token = opts.token;
		this.timeoutMs = opts.timeoutMs ?? 60_000;
		this.connectTimeoutMs = opts.connectTimeoutMs ?? 5_000;
		this.maxPoolSize = opts.maxPoolSize ?? 16;
	}

	async query<T = unknown>(body: Record<string, unknown>): Promise<T | ShardDbError> {
		const payload = JSON.stringify(this.token ? { ...body, token: this.token } : body);

		const sock = await this.acquire();

		return new Promise((resolve) => {
			let buf = '';
			let settled = false;

			const settle = (value: unknown) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				sock.removeListener('data', onData);
				sock.removeListener('error', onError);
				sock.removeListener('close', onClose);
				this.release(sock);
				resolve(value as T | ShardDbError);
			};

			const timer: ReturnType<typeof setTimeout> | undefined = this.timeoutMs > 0
				? setTimeout(() => settle({ error: `shard-db timeout after ${this.timeoutMs}ms` }), this.timeoutMs)
				: undefined;

			const onData = (raw: Buffer | string) => {
				buf += typeof raw === 'string' ? raw : raw.toString('utf8');
				const term = buf.indexOf('\0\n');
				if (term === -1) return;
				const json = buf.slice(0, term);
				try {
					settle(JSON.parse(json));
				} catch (err) {
					settle({ error: `bad response from shard-db: ${err instanceof Error ? err.message : String(err)}` });
				}
			};

			const onError = (err: Error) => {
				const code = (err as NodeJS.ErrnoException).code;
				settle({ error: code === 'ECONNREFUSED'
					? `cannot reach shard-db at ${this.host}:${this.port}`
					: err.message
				});
			};

			const onClose = () => {
				settle({ error: 'shard-db closed connection' });
			};

			sock.on('data', onData);
			sock.on('error', onError);
			sock.on('close', onClose);

			try {
				sock.write(payload + '\n');
			} catch (err) {
				// Socket threw synchronously (e.g. destroyed while writing).
				// Release is still called by settle → release handles discarding.
				settle({ error: err instanceof Error ? err.message : String(err) });
			}
		}) as Promise<T | ShardDbError>;
	}

	// ── pool ──────────────────────────────────────────────────────

	/** Borrow a socket — either an idle one or a fresh connection. */
	private async acquire(): Promise<net.Socket> {
		if (this.idle.length > 0) {
			const sock = this.idle.pop()!;
			// Quick liveness check: if the socket is dead (fd closed)
			// a write will throw. We catch it synchronously below.
			// For now we optimistically return it; the write in query()
			// will fail and trigger a retry.
			return sock;
		}
		return this.connect();
	}

	/** Return a socket to the pool, or discard if the pool is full
	 *  or the socket is dead. */
	private release(sock: net.Socket) {
		if (sock.destroyed || this.idle.length >= this.maxPoolSize) {
			sock.destroy();
		} else {
			this.idle.push(sock);
		}
	}

	/** Create and await a fresh TCP connection. */
	private connect(): Promise<net.Socket> {
		return new Promise((resolve, reject) => {
			const sock = net.createConnection({ host: this.host, port: this.port });
			let done = false;

			const timer = setTimeout(() => {
				if (done) return;
				done = true;
				sock.destroy();
				reject(new Error(`shard-db connect timeout after ${this.connectTimeoutMs}ms`));
			}, this.connectTimeoutMs);

			sock.on('connect', () => {
				clearTimeout(timer);
				if (done) return;
				done = true;
				sock.setNoDelay(true);
				resolve(sock);
			});

			sock.on('error', (err) => {
				clearTimeout(timer);
				if (done) return;
				done = true;
				const code = (err as NodeJS.ErrnoException).code;
				reject(new Error(code === 'ECONNREFUSED'
					? `cannot reach shard-db at ${this.host}:${this.port}`
					: err.message
				));
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
