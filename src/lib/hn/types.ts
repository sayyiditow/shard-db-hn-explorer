/** Canonical record shapes returned by shard-db's `find` mode.
 *
 *  All `time` / `created` fields are stored as `timestamp` —
 *  Unix epoch **milliseconds**, matching JS `Date` natively.
 *  Conversion from HN's Firebase API (which returns seconds) is
 *  handled by `scripts/sample-load.ts` and `scripts/delta-refresh.ts`. */

export interface Story {
	key: string;        // HN id as decimal string
	by: string;
	time: number;       // unix ms
	score: number;
	url: string;
	title: string;
	descendants: number;
	type: string;       // "story" | "job" | "poll" | "pollopt"
	deleted: boolean;
	dead: boolean;
}

export interface Comment {
	key: string;
	by: string;
	time: number;       // unix ms
	parent: number;
	story_root: number;
	text: string;       // raw HN-format HTML
	deleted: boolean;
	dead: boolean;
}

export interface UserProfile {
	key: string;        // username
	karma: number;
	created: number;    // unix ms
	about: string;
	submitted_count: number;
}

/** shard-db `find` returns an array of records by default. Each record
 * lands as `{ key, value }` in the new bare-shape protocol (2026.05.1+)
 * when `format` is unset, OR as a bare object when individual record
 * fields are projected directly. We default to using format="dict"
 * for keyed lookups and format=(array of records) for ordered results. */

export type FindRow<T> = T & { key: string };
