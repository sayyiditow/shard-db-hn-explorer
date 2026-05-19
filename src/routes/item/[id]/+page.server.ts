import { error } from '@sveltejs/kit';
import { shardDb, isError } from '$lib/shard-db/client';
import { buildCommentTree, countNodes } from '$lib/hn/comment-tree';
import type { Story, Comment } from '$lib/hn/types';
import type { PageServerLoad } from './$types';

const COMMENTS_PAGE_SIZE = 500;

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
	const commentsResp = await shardDb.query({
		mode: 'find',
		dir: 'hn',
		object: 'comments',
		criteria: [{ field: 'story_root', op: 'eq', value: idNum }],
		order_by: { field: 'time', dir: 'asc' },
		limit: COMMENTS_PAGE_SIZE,
		format: 'dict'
	});
	const commentsMs = performance.now() - tComments;

	let comments: Comment[] = [];
	let commentsError: string | undefined;
	if (isError(commentsResp)) {
		commentsError = commentsResp.error;
	} else {
		const dict = commentsResp as Record<string, Omit<Comment, 'key'>>;
		comments = Object.entries(dict).map(([key, value]) => ({ key, ...value }));
	}

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
		hasMore: comments.length === COMMENTS_PAGE_SIZE && totalNodes < (story.descendants ?? 0)
	};
};
