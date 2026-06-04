# Item-page comment pagination (B-lite) + drop `time+score` from schema

> **For agentic workers:** implement task-by-task; leave everything **uncommitted** for review (do not commit/push). Build/typecheck gates: `bun run check` (svelte-check) and `bun run build` — both must pass. This is the SvelteKit explorer repo (`shard-db-hn-explorer`), Svelte 5 runes + SvelteKit 2.
> If a quoted anchor isn't found, STOP and write `PLAN_NOTES.md` rather than guess.

**Goal:** The story/item page currently loads up to **500** comments (`story_root=id ORDER BY time ASC limit 500`) and renders the whole tree — which both truncates big threads ("500 of 967") and dumps a huge DOM. Switch to **B-lite**: load the *full* thread in one (already-fast, ~343ms) query, build the tree as today, and **paginate the rendering of root threads** (show 25 root threads, "Load more" reveals +25, pure client-side — no extra round-trips). Result: complete threads, threaded view preserved, small initial DOM, instant "load more".

**Why B-lite (not cursor):** comments only carry `parent` (direct) + `story_root` (top story) — no ancestor/thread-root field — so true per-thread wire-pagination would need a schema change + 38M-row backfill. B-lite keeps the single bounded query (fast) and paginates client-side. (If mega-thread transfer ever hurts, a `thread_root` field enables true cursor pagination later — out of scope here.)

**Setup:** `git checkout main && git pull && git checkout -b feat/item-comment-pagination`

---

### Task 0: Drop `time+score` from the schema index list

`time+score` was removed from the live DB (it's never selectable — the planner only uses a composite when its first field is pinned by `eq`, and `time` is always a range). Keep the code in sync so a reload doesn't re-add it.

**File:** `scripts/lib/hn-schema.ts`

- [ ] **Step 1:** In `INDEX_LISTS.stories`, remove the `'time+score',` line. (If already absent, skip.) Result:

```ts
	stories: [
		'by',
		'time',
		'score',
		'type',
		'dead',
		'deleted',
		'title:trigram',
		'by+time',
		'type+time'
	],
```

- [ ] **Step 2:** `bun run check` → no new errors.

---

### Task 1: Load the full thread (uncap)

**File:** `src/routes/item/[id]/+page.server.ts`

- [ ] **Step 1:** Replace the page-size constant.

Find:
```ts
const COMMENTS_PAGE_SIZE = 500;
const NEAR_CONTEXT = 50;
```
Replace with:
```ts
// Full-thread load: HN threads ~never exceed this. The single story_root=id
// ORDER BY time query is already ~ms-to-sub-second; rendering is paginated
// client-side (see +page.svelte). Cap is a safety bound for pathological threads.
const MAX_THREAD_COMMENTS = 5000;
const NEAR_CONTEXT = 50;
```

- [ ] **Step 2:** Use the new constant in the main (non-`near`) comment query.

Find:
```ts
			order_by: 'time',
			order: 'asc',
			limit: COMMENTS_PAGE_SIZE
		});
```
Replace `limit: COMMENTS_PAGE_SIZE` with `limit: MAX_THREAD_COMMENTS`.

- [ ] **Step 3:** Update the `hasMore` derivation in the return object.

Find:
```ts
		hasMore: nearKey ? false : (comments.length === COMMENTS_PAGE_SIZE && totalNodes < (story.descendants ?? 0))
```
Replace with:
```ts
		hasMore: nearKey ? false : (comments.length === MAX_THREAD_COMMENTS && totalNodes < (story.descendants ?? 0))
```
(So `hasMore` now means "thread exceeded the safety cap" — rare — not "more beyond 500".)

- [ ] **Step 4:** `bun run check` → no new errors.

---

### Task 2: Client-side render-pagination of root threads

**File:** `src/routes/item/[id]/+page.svelte`

- [ ] **Step 1:** Add the visible-roots state + reset on navigation.

After the existing `let { data }: { data: PageData } = $props();` and the `$derived` lines, add:
```ts
	const ROOTS_STEP = 25;
	let visibleRoots = $state(ROOTS_STEP);
```
Then, inside the existing `afterNavigate(() => { ... })` callback, at the **top** of the callback body, add a reset so switching stories starts fresh:
```ts
		visibleRoots = ROOTS_STEP;
```

- [ ] **Step 2:** Render only the visible root threads + a "Load more" button.

Find the render block:
```svelte
		<div class="thread">
			{#each data.comments as node (node.comment.key)}
				<Comment {node} />
			{/each}
		</div>
		{#if data.hasMore}
			<p class="more-note">
				Showing the first batch of comments — pagination beyond this page is a Phase 3 follow-up.
			</p>
		{/if}
```
Replace with:
```svelte
		<div class="thread">
			{#each data.comments.slice(0, visibleRoots) as node (node.comment.key)}
				<Comment {node} />
			{/each}
		</div>
		{#if visibleRoots < data.comments.length}
			<button class="load-more" onclick={() => (visibleRoots += ROOTS_STEP)}>
				Load more comments ({(data.comments.length - visibleRoots).toLocaleString()} threads left)
			</button>
		{/if}
		{#if data.hasMore}
			<p class="more-note">
				Thread capped at {MAX_THREAD_COMMENTS.toLocaleString()} comments.
			</p>
		{/if}
```
Note: `data.comments` is the array of **root** tree nodes (each `<Comment>` renders its full subtree), so slicing it paginates *threads*, not individual comments — nesting is preserved. `MAX_THREAD_COMMENTS` isn't in scope in the component; either hard-code `5000` in that note or drop the note's number (the `data.hasMore` branch is rare). Simplest: change the note text to `Thread truncated — too large to display fully.` to avoid importing the constant.

- [ ] **Step 3:** Add minimal styling for `.load-more` (match existing button styles in the `<style>` block; a plain bordered button is fine):
```css
	.load-more {
		margin: 1rem 0;
		padding: 0.5rem 1rem;
		font: inherit;
		cursor: pointer;
		background: transparent;
		border: 1px solid var(--border, #444);
		border-radius: 6px;
		color: inherit;
	}
	.load-more:hover { background: var(--hover, rgba(255,255,255,0.05)); }
```

- [ ] **Step 4:** `bun run check && bun run build` → both pass, no new errors.

---

### Task 3: Manual verification (no automated UI test)

- [ ] **Step 1:** `bun run dev`, open a large story (e.g. the 967-comment one). Confirm:
  - Initial render shows **25 root threads** (each with its nested replies), not 500/967.
  - "Load more comments (N threads left)" appears; clicking reveals +25 root threads with **no network request** (check devtools Network — only the initial page load).
  - The header count shows the **full** total (no "500 of 967" truncation) — complete thread is loaded, just rendered incrementally.
  - Navigating to a different story resets to 25 visible.
- [ ] **Step 2:** Report the `bun run check` / `bun run build` output and the manual results.

---

## Notes for the reviewer
- B-lite trades wire-transfer (full thread) for simplicity + completeness + zero extra round-trips. The DB query is unchanged in shape (just a higher limit) and already fast via `story_root+time`.
- The `?near=` deep-link path (before/after 50) is untouched and becomes ~ms once the shard-db range-fold build (PR #119) is deployed.
- Real per-thread wire pagination (B-full) would need a `thread_root` comment field + backfill — deferred.
