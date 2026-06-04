import { error } from '@sveltejs/kit';
import { shardDb, isError } from '$lib/shard-db/client';
import { buildCommentTree, countNodes } from '$lib/hn/comment-tree';
import type { Story, Comment } from '$lib/hn/types';
import type { PageServerLoad } from './$types';

// Full-thread load: HN threads ~never exceed this. The single story_root=id
// ORDER BY time query is already ~ms-to-sub-second; rendering is paginated
// client-side (see +page.svelte). Cap is a safety bound for pathological threads.
const MAX_THREAD_COMMENTS = 5000;
const NEAR_CONTEXT = 50;

export const load: PageServerLoad = async ({ params, url }) => {
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
	const nearKey = url.searchParams.get('near');

	let comments: Comment[] = [];
	let commentsError: string | undefined;
	let nearFailed = false;

	if (nearKey) {
		const targetResp = await shardDb.query({
			mode: 'get', dir: 'hn', object: 'comments', key: nearKey
		});

		if (!isError(targetResp)) {
			const target: Comment = { key: nearKey, ...(targetResp as Omit<Comment, 'key'>) };

			const mapFlat = (resp: unknown, excludeKey?: string): Comment[] => {
				if (isError(resp)) return [];
				return (resp as Array<{ key: string; value: Omit<Comment, 'key'> }>)
					.map((r) => ({ key: r.key, ...r.value } as Comment))
					.filter((c) => c.key !== excludeKey);
			};

			const [beforeResp, afterResp] = await Promise.all([
				shardDb.query({
					mode: 'find', dir: 'hn', object: 'comments',
					criteria: [
						{ field: 'story_root', op: 'eq', value: idNum },
						{ field: 'time', op: 'lte', value: target.time }
					],
					order_by: 'time', order: 'desc', limit: NEAR_CONTEXT
				}),
				shardDb.query({
					mode: 'find', dir: 'hn', object: 'comments',
					criteria: [
						{ field: 'story_root', op: 'eq', value: idNum },
						{ field: 'time', op: 'gte', value: target.time }
					],
					order_by: 'time', order: 'asc', limit: NEAR_CONTEXT + 1
				})
			]);

			const before = mapFlat(beforeResp, nearKey).reverse();
			const after = mapFlat(afterResp, nearKey);
			const raw = [...before, target, ...after];
			const seen = new Set<string>();
			comments = raw.filter((c) => (seen.has(c.key) ? false : seen.add(c.key)));
		}

		if (comments.length === 0) {
			nearFailed = true;
		}
	}

	if (!nearKey || nearFailed) {
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
		hasMore: nearKey ? false : (comments.length === MAX_THREAD_COMMENTS && totalNodes < (story.descendants ?? 0))
	};
};
