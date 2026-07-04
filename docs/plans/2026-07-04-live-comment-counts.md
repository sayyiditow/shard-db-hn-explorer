# Replace stale stored comment counts with live counts

> **For agentic workers:** implement task-by-task; leave everything **uncommitted** for review (do not commit/push). Build/typecheck gates: `bun run check` (svelte-check) and `bun run build` — both must pass. This is the SvelteKit explorer repo (`shard-db-hn-explorer`), Svelte 5 runes + SvelteKit 2.
> If a quoted anchor isn't found, STOP and write `PLAN_NOTES.md` rather than guess.

**Bug:** the home page and trending page show each story's comment count from the stored `descendants` field on the `stories` object. That field is written once, in `src/lib/refresh-cache/refresh.ts`, when the story's own id is first processed during ingestion (`descendants: it.descendants ?? 0`) — it is never refreshed afterward. The thread page (`src/routes/item/[id]/+page.server.ts`) instead computes its count live, by querying the `comments` object for `story_root = <id>` and counting the resulting tree on every page load. Result: list pages show a stale number (e.g. "54 comments") while the same story's thread page shows the true, current number (e.g. "176 comments").

**Fix:** replace the stored-`descendants` display with a live, indexed count everywhere a list of stories is rendered (home page, trending page, user profile page). `story_root` is already btree-indexed on `comments` (plus a `story_root+time` composite — see `INDEX_LISTS.comments` in `scripts/lib/hn-schema.ts`), so counting comments per story is cheap. Rather than one `count` query per story, use a single grouped `aggregate` call per page render — one round trip covers every story currently on the page. This must bypass the 5-minute `cachedQuery()` cache wrapper (`src/lib/refresh-cache/cached-query.ts`) entirely — a cached live-count would just reintroduce staleness up to 5 minutes, defeating the point. Call `shardDb.query()` directly, the same way `src/routes/u/[username]/+page.server.ts` already does for its other two queries.

No Svelte template changes are needed: all three pages already render `s.descendants ?? 0` (see e.g. `src/routes/+page.svelte:358`, `src/routes/trending/+page.svelte:79`) — overwriting `descendants` server-side with the live count is sufficient.

**Setup:** `git checkout main && git pull && git checkout -b feat/live-comment-counts`

---

### Task 1: Shared live-comment-count helper

**File:** `src/lib/hn/comment-counts.ts` (new file)

- [ ] **Step 1:** Create the file with the following content:

```ts
import { shardDb, isError } from '$lib/shard-db/client';

/**
 * Live comment counts for a set of story ids, keyed on the already-indexed
 * `story_root` field on the `comments` object. One grouped aggregate call
 * covers every story on the page in a single round trip, instead of one
 * `count` query per story.
 *
 * Returns `null` on query failure — callers should keep each story's
 * existing stored `descendants` value as a fallback in that case. This is
 * distinct from an empty/partial `Map`: a story id absent from a
 * *successful* response legitimately has zero live comments (it just never
 * appears as a `group_by` row), so callers should treat "present in a
 * non-null map with no entry" as 0, not as "unknown, keep the stale value".
 */
export async function fetchLiveCommentCounts(
	storyIds: string[]
): Promise<Map<string, number> | null> {
	if (storyIds.length === 0) return new Map();

	const ids = storyIds.map((id) => Number(id)).filter((n) => Number.isFinite(n));
	if (ids.length === 0) return new Map();

	const resp = await shardDb.query({
		mode: 'aggregate',
		dir: 'hn',
		object: 'comments',
		group_by: ['story_root'],
		aggregates: [{ fn: 'count', alias: 'n' }],
		criteria: [{ field: 'story_root', op: 'in', value: ids }]
	});

	if (isError(resp) || !Array.isArray(resp)) return null;

	const counts = new Map<string, number>();
	for (const row of resp as Array<Record<string, unknown>>) {
		const key = String(row.story_root);
		const n = typeof row.n === 'number' ? row.n : 0;
		counts.set(key, n);
	}
	return counts;
}

/**
 * Overwrites each story's `descendants` with its live comment count.
 * Stories with zero live comments correctly become 0 (they're simply
 * absent from the aggregate's group-by rows). On aggregate failure,
 * stories are returned unmodified — the stale stored value is still
 * better than failing the whole page load.
 */
export async function applyLiveCommentCounts<T extends { key: string; descendants?: number }>(
	stories: T[]
): Promise<T[]> {
	if (stories.length === 0) return stories;
	const counts = await fetchLiveCommentCounts(stories.map((s) => s.key));
	if (counts === null) return stories;
	return stories.map((s) => ({ ...s, descendants: counts.get(s.key) ?? 0 }));
}
```

- [ ] **Step 2:** `bun run check` → no new errors (the `shardDb`/`isError` imports and `aggregate` mode must typecheck against `$lib/shard-db/client` and the `shard-db` package's ambient `ShardDb` types, same as existing usages in `src/lib/refresh-cache/slow-stats.ts`).

---

### Task 2: Wire into the home page

**File:** `src/routes/+page.server.ts`

- [ ] **Step 1:** Add the import.

Find:
```ts
import { isError } from '$lib/shard-db/client';
import { cachedQuery, windowAnchor } from '$lib/refresh-cache';
import type { Story, Comment } from '$lib/hn/types';
import type { PageServerLoad } from './$types';
```

Replace with:
```ts
import { isError } from '$lib/shard-db/client';
import { cachedQuery, windowAnchor } from '$lib/refresh-cache';
import { applyLiveCommentCounts } from '$lib/hn/comment-counts';
import type { Story, Comment } from '$lib/hn/types';
import type { PageServerLoad } from './$types';
```

- [ ] **Step 2:** Apply live counts to the mapped rows, but only when the source object is `stories` — `comments` rows have no `descendants` field at all, so skip them.

Find:
```ts
	const items: Array<Story | Comment> = rows.map((r) =>
		({ key: r.key, ...r.value } as Story | Comment)
	);
	const totalCount: number | null = cr.total ?? null;
```

Replace with:
```ts
	let items: Array<Story | Comment> = rows.map((r) =>
		({ key: r.key, ...r.value } as Story | Comment)
	);
	if (sourceObject === 'stories') {
		items = await applyLiveCommentCounts(items as Story[]);
	}
	const totalCount: number | null = cr.total ?? null;
```

- [ ] **Step 3:** `bun run check` → no new errors.

---

### Task 3: Wire into the trending page

**File:** `src/routes/trending/+page.server.ts`

- [ ] **Step 1:** Add the import.

Find:
```ts
import { isError } from '$lib/shard-db/client';
import { cachedQuery, windowAnchor } from '$lib/refresh-cache';
import type { Story } from '$lib/hn/types';
import type { PageServerLoad } from './$types';
```

Replace with:
```ts
import { isError } from '$lib/shard-db/client';
import { cachedQuery, windowAnchor } from '$lib/refresh-cache';
import { applyLiveCommentCounts } from '$lib/hn/comment-counts';
import type { Story } from '$lib/hn/types';
import type { PageServerLoad } from './$types';
```

- [ ] **Step 2:** Apply live counts after mapping the top-stories rows (`trending` only ever queries the `stories` object, so no source-object gate is needed here).

Find:
```ts
	const rows = topStoriesResp as Array<{ key: string; value: Omit<Story, 'key'> }>;
	const stories: Story[] = rows.map((r) => ({ key: r.key, ...r.value }));
	const totalCount = totalCountResp as number;
```

Replace with:
```ts
	const rows = topStoriesResp as Array<{ key: string; value: Omit<Story, 'key'> }>;
	const stories: Story[] = await applyLiveCommentCounts(
		rows.map((r) => ({ key: r.key, ...r.value }))
	);
	const totalCount = totalCountResp as number;
```

- [ ] **Step 3:** `bun run check` → no new errors. Note that the domain-bucket loop later in this function (`for (const s of stories) { ... }`) only reads `s.url` and `s.score`, so it is unaffected by this change and needs no edit.

---

### Task 4: Wire into the user profile page

**File:** `src/routes/u/[username]/+page.server.ts`

- [ ] **Step 1:** Add the import.

Find:
```ts
import { error } from '@sveltejs/kit';
import { shardDb, isError } from '$lib/shard-db/client';
import type { UserProfile, Story, Comment } from '$lib/hn/types';
import type { PageServerLoad } from './$types';
```

Replace with:
```ts
import { error } from '@sveltejs/kit';
import { shardDb, isError } from '$lib/shard-db/client';
import { applyLiveCommentCounts } from '$lib/hn/comment-counts';
import type { UserProfile, Story, Comment } from '$lib/hn/types';
import type { PageServerLoad } from './$types';
```

- [ ] **Step 2:** Apply live counts to this user's stories.

Find:
```ts
	let stories: Story[] = [];
	let storiesError: string | undefined;
	if (isError(storiesResp)) {
		storiesError = storiesResp.error;
	} else {
		const arr = storiesResp as Array<{ key: string; value: Omit<Story, 'key'> }>;
		stories = arr.map((r) => ({ key: r.key, ...r.value }));
	}
```

Replace with:
```ts
	let stories: Story[] = [];
	let storiesError: string | undefined;
	if (isError(storiesResp)) {
		storiesError = storiesResp.error;
	} else {
		const arr = storiesResp as Array<{ key: string; value: Omit<Story, 'key'> }>;
		stories = await applyLiveCommentCounts(arr.map((r) => ({ key: r.key, ...r.value })));
	}
```

- [ ] **Step 3:** `bun run check` → no new errors.

---

### Task 5: Build and manual verification

- [ ] **Step 1:** `bun run build` → succeeds with no new errors or warnings.
- [ ] **Step 2:** Manual sanity check — `bun run dev`:
  - Open the home page, note the comment count shown on the "Ask HN: Is anyone experimenting with different ways of using LLMs for coding?" story (or any story with a large, active thread).
  - Open that same story's thread page (`/item/<id>`) and compare its "N comments" heading.
  - The two numbers must now match (both live), instead of the home page showing a smaller, stale number.
  - Repeat the comparison on `/trending` and on a `/u/<username>` profile page that has at least one story with replies.
  - Load the home page filtered to `category=comment` (`sourceObject === 'comments'`) and confirm it still renders without error (comments have no `descendants` field, so this path must be untouched by the live-count logic).

---

### Notes for review

- The live-count query always calls `shardDb.query()` directly (never `cachedQuery()`), by design — the whole point is to bypass the 5-minute cache that caused the original staleness.
- `fetchLiveCommentCounts` returns `null` (not an empty `Map`) on query failure specifically so callers can distinguish "the aggregate call failed, keep the stale stored value" from "the aggregate call succeeded and this story genuinely has 0 live comments" (which correctly zeroes out `descendants`, since a story with 0 comments never appears as a `group_by` row).
- One `aggregate` call per page load, grouped over the story ids already being displayed (≤30 per page across all three routes) — not one `count` per story. `story_root` is already btree-indexed on `comments`, so this is a fast, indexed grouped read even at HN's current comment volume.
- No changes needed to `src/lib/refresh-cache/refresh.ts` — the stored `descendants` field is left as-is (still written at ingestion, still used as a fallback on aggregate failure); it's just no longer trusted as the primary display value.
