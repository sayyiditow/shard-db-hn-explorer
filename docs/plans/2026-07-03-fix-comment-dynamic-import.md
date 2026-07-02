# Fix ineffective dynamic self-import in Comment.svelte

> **For agentic workers:** implement task-by-task; leave everything **uncommitted** for review (do not commit/push). Build/typecheck gates: `bun run check` (svelte-check) and `bun run build` — both must pass. This is the SvelteKit explorer repo (`shard-db-hn-explorer`), Svelte 5 runes + SvelteKit 2.
> If a quoted anchor isn't found, STOP and write `PLAN_NOTES.md` rather than guess.

**Goal:** `bun run build` emits a vite warning on every build:

```
[INEFFECTIVE_DYNAMIC_IMPORT] src/lib/components/Comment.svelte is dynamically imported
by src/lib/components/Comment.svelte but also statically imported by
src/routes/item/[id]/+page.svelte, dynamic import will not move module into another chunk.
```

`Comment.svelte` renders its nested replies by recursively rendering itself, and currently does this via a dynamic `import()` inside an `{#await}` block — a workaround pattern from older Svelte/bundler versions where a component couldn't statically self-import without a circular-init problem. Since `Comment.svelte` is *also* statically imported by `src/routes/item/[id]/+page.svelte` (the page that renders the top-level comment tree), the whole module is already in that page's chunk by the time the dynamic import would resolve — so the dynamic import achieves no code-splitting, it's pure overhead (an extra microtask/promise indirection per rendered comment, on every comment in every thread).

Svelte 5 + Vite handle a component statically importing itself just fine (ES module circular bindings are resolved by the time the component actually recurses at render time, well after module evaluation completes) — this is a standard, common pattern for recursive UI trees (comment threads, file trees, org charts). Switch to a plain static self-import and drop the `{#await}` wrapper.

**Setup:** `git checkout main && git pull && git checkout -b fix/comment-dynamic-import`

---

### Task 1: Static self-import instead of dynamic

**File:** `src/lib/components/Comment.svelte`

- [ ] **Step 1:** Add a static self-import alongside the existing imports at the top of the `<script>` block.

Find:
```svelte
	import { relativeTime, absoluteTime, hnItemUrl } from '$lib/hn/format';
	import { sanitiseHnHtml } from '$lib/hn/sanitize';
	import type { CommentNode } from '$lib/hn/comment-tree';
```

Replace with:
```svelte
	import { relativeTime, absoluteTime, hnItemUrl } from '$lib/hn/format';
	import { sanitiseHnHtml } from '$lib/hn/sanitize';
	import type { CommentNode } from '$lib/hn/comment-tree';
	import Comment from './Comment.svelte';
```

- [ ] **Step 2:** Replace the `{#await import(...)}` block with a direct recursive render.

Find:
```svelte
				{#each node.children as child (child.comment.key)}
					{#await import('./Comment.svelte') then m}
						<m.default node={child} depth={depth + 1} />
					{/await}
				{/each}
```

Replace with:
```svelte
				{#each node.children as child (child.comment.key)}
					<Comment node={child} depth={depth + 1} />
				{/each}
```

- [ ] **Step 3:** `bun run check` → no new errors.
- [ ] **Step 4:** `bun run build` → the `INEFFECTIVE_DYNAMIC_IMPORT` warning for `Comment.svelte` no longer appears in the output.
- [ ] **Step 5:** Manual sanity check — `bun run dev`, open any item page with nested comment replies, confirm the thread still renders correctly at multiple depths and collapse/expand still works.

---

### Notes for review

This is a pure refactor — no behavior change to what's rendered, only how the recursive component reference is resolved (compile-time static binding instead of a runtime dynamic `import()` promise). No test coverage exists for `Comment.svelte` specifically; the manual sanity check in Step 5 is the verification for this change.
