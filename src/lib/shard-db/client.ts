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
import type { QueryBody } from './query-types';
import { EmbeddedShardDbClient } from './embedded';

/** No-op data sink for idle pool sockets — see installIdleMarkers().
 *  Defined at module scope so removeListener can target it by identity. */
function noopDrain(_chunk: Buffer | string): void { /* discard */ }

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

/** Shared interface implemented by ShardDbClient (TCP) and EmbeddedShardDbClient. */
export interface IShardDbClient {
	query<T = unknown>(body: QueryBody): Promise<T | ShardDbError>;
	close(): void;
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

	async query<T = unknown>(body: QueryBody): Promise<T | ShardDbError> {
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

	/** True iff the socket is in a usable, fully-connected state.  Catches:
	 *   - sockets we've already destroyed
	 *   - sockets the idle-time markers below flagged as dead (server FIN)
	 *   - half-open sockets that can only read or only write
	 *
	 * Why both `_poolDead` AND the standard flags? When a socket sits idle
	 * with no JS listeners attached, the libuv side still receives the
	 * server's FIN — but Node's high-level Socket state (destroyed /
	 * readyState) may not update synchronously until a read or write is
	 * attempted. We attach a `close`/`error` once-listener while idle that
	 * flips `_poolDead` the moment libuv delivers the close event,
	 * regardless of whether anyone is currently reading. acquire() then
	 * has a reliable "this is dead" signal to consult. */
	private isAlive(sock: net.Socket): boolean {
		if ((sock as unknown as { _poolDead?: boolean })._poolDead) return false;
		return !sock.destroyed
			&& sock.readable
			&& sock.writable
			&& sock.readyState === 'open';
	}

	/** Mark a socket dead from a libuv close/error event while it sits idle.
	 *  Why the no-op `data` listener too: a TCP socket without a `data`
	 *  listener is in PAUSED mode, and libuv may not deliver close/end
	 *  events promptly because it's not polling EPOLLIN.  Attaching a
	 *  data listener flips the socket back to flowing mode so libuv
	 *  keeps polling — close/end events then fire as soon as the kernel
	 *  delivers FIN.  The pool protocol means we should never actually
	 *  receive data while idle (the server replies once per request and
	 *  the read is complete by the time release() runs), so the data
	 *  listener is effectively a "keep the fd live" beacon. */
	private installIdleMarkers(sock: net.Socket) {
		const mark = () => { (sock as unknown as { _poolDead?: boolean })._poolDead = true; };
		sock.once('close', mark);
		sock.once('error', mark);
		sock.once('end', mark);
		sock.on('data', noopDrain);
	}

	/** Remove the idle-time markers when borrowing the socket back for a
	 *  query — query()'s own listeners take over and we don't want a stray
	 *  close-during-query to flip `_poolDead` mid-flight. */
	private removeIdleMarkers(sock: net.Socket) {
		sock.removeAllListeners('close');
		sock.removeAllListeners('error');
		sock.removeAllListeners('end');
		sock.removeListener('data', noopDrain);
	}

	/** Borrow a socket — drain dead idles first, then fall through to a
	 *  fresh connect.  After a shard-db restart the pool is full of dead
	 *  sockets (server-side FIN already delivered, _poolDead flipped); we
	 *  destroy them silently here so the user-facing query sees a live
	 *  connection on its very first attempt. */
	private async acquire(): Promise<net.Socket> {
		while (this.idle.length > 0) {
			const sock = this.idle.pop()!;
			this.removeIdleMarkers(sock);
			if (this.isAlive(sock)) return sock;
			sock.destroy();
		}
		return this.connect();
	}

	/** Return a socket to the pool, or discard if the pool is full or the
	 *  socket has gone bad during the query.  When pooling, attach the
	 *  idle-time markers so a server-side close while idle gets caught. */
	private release(sock: net.Socket) {
		if (this.idle.length >= this.maxPoolSize || !this.isAlive(sock)) {
			sock.destroy();
		} else {
			this.installIdleMarkers(sock);
			this.idle.push(sock);
		}
	}

	/** Destroy every idle pool socket.  Useful in one-shot scripts
	 *  (setup-schema, bulk-load) so the Bun/Node process can exit
	 *  cleanly once work is done — otherwise the pool's open sockets
	 *  keep the event loop alive indefinitely.  Safe to call
	 *  multiple times; new queries after close() will simply
	 *  re-connect on demand. */
	close(): void {
		while (this.idle.length > 0) {
			const sock = this.idle.pop();
			if (sock) {
				this.removeIdleMarkers(sock);
				sock.destroy();
			}
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

/** Default singleton — mode-switched via SHARD_DB_MODE.
 *
 *  SHARD_DB_MODE=embedded → in-process via npm native addon (no daemon).
 *    Requires SHARD_DB_ROOT to be set to the absolute data dir path.
 *  SHARD_DB_MODE unset    → TCP connection pool (default). */
export const shardDb: IShardDbClient = process.env.SHARD_DB_MODE === 'embedded'
	? new EmbeddedShardDbClient(
		process.env.SHARD_DB_ROOT
			?? (() => { throw new Error('SHARD_DB_ROOT must be set when SHARD_DB_MODE=embedded'); })()
	  )
	: new ShardDbClient({
		host: process.env.SHARD_DB_HOST,
		port: process.env.SHARD_DB_PORT ? Number(process.env.SHARD_DB_PORT) : undefined,
		token: process.env.SHARD_DB_TOKEN
	  });

export function isError(resp: unknown): resp is ShardDbError {
	return typeof resp === 'object' && resp !== null && 'error' in resp;
}
