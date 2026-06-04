import { error } from '@sveltejs/kit';
import { shardDb, isError } from '$lib/shard-db/client';
import { buildCommentTree, countNodes } from '$lib/hn/comment-tree';
import type { Story, Comment } from '$lib/hn/types';
import type { PageServerLoad } from './$types';

// Full-thread load: HN threads ~never exceed this. The single story_root=id
// ORDER BY time query is already ~ms-to-sub-second; rendering is paginated
// client-side (see +page.svelte). Cap is a safety bound for pathological threads.
const MAX_THREAD_COMMENTS = 5000;

export const load: PageServerLoad = async ({ params }) => {
	const idStr = params.id;
	const idNum = Number(idStr);
	if (!Number.isFinite(idNum) || !/^\d+$/.test(idStr)) {
		throw error(400, 'Bad item id');
	}

	const tStory = performance.now();
	const storyResp = await shardDb.query({
		mode: 'get',
		dir: 'hn',
		object: 'stories',
		key: idStr
	});
	const storyMs = performance.now() - tStory;

	if (isError(storyResp)) {
		throw error(404, `Story ${idStr} not found (${storyResp.error})`);
	}
	const story: Story = { key: idStr, ...(storyResp as Omit<Story, 'key'>) };

	const tComments = performance.now();

	// Always load the full thread (one indexed story_root=id walk, ~ms-to-sub-
	// second). Deep-linking to a specific comment is handled purely client-side
	// via the `#c<key>` hash anchor (see +page.svelte) — no server-side `?near=`
	// window queries. Those used to fire two extra `time`-range finds per click
	// from profile-comment links and showed up as multi-second slow queries.
	let comments: Comment[] = [];
	let commentsError: string | undefined;

	const commentsResp = await shardDb.query({
		mode: 'find',
		dir: 'hn',
		object: 'comments',
		criteria: [{ field: 'story_root', op: 'eq', value: idNum }],
		order_by: 'time',
		order: 'asc',
		limit: MAX_THREAD_COMMENTS
	});

	if (isError(commentsResp)) {
		commentsError = commentsResp.error;
	} else {
		const arr = commentsResp as Array<{ key: string; value: Omit<Comment, 'key'> }>;
		comments = arr.map((r) => ({ key: r.key, ...r.value }));
	}

	const commentsMs = performance.now() - tComments;

	const tree = buildCommentTree(comments, idNum);
	const totalNodes = countNodes(tree);

	return {
		story,
		comments: tree,
		commentsTotal: totalNodes,
		commentsError,
		storyMs,
		commentsMs,
		totalMs: storyMs + commentsMs,
		hasMore: comments.length === MAX_THREAD_COMMENTS && totalNodes < (story.descendants ?? 0)
	};
};
