import { error } from '@sveltejs/kit';
import { shardDb, isError } from '$lib/shard-db/client';
import type { UserProfile, Story, Comment } from '$lib/hn/types';
import type { PageServerLoad } from './$types';

const RECENT_LIMIT = 25;

export const load: PageServerLoad = async ({ params }) => {
	const username = params.username;
	if (!username || username.length > 32 || !/^[A-Za-z0-9_-]+$/.test(username)) {
		throw error(400, 'Bad username');
	}

	const t0 = performance.now();

	// One round trip per object; run in parallel since the queries don't depend
	// on each other. Even if the user record is missing, we still show whatever
	// stories/comments we have under that `by` (HN keeps activity on missing
	// users sometimes — same as their own profile page).
	const [userResp, storiesResp, commentsResp] = await Promise.all([
		shardDb.query({ mode: 'get', dir: 'hn', object: 'users', key: username }),
		shardDb.query({
			mode: 'find',
			dir: 'hn',
			object: 'stories',
			criteria: [{ field: 'by', op: 'eq', value: username }],
			order_by: { field: 'time', dir: 'desc' },
			limit: RECENT_LIMIT,
			format: 'dict'
		}),
		shardDb.query({
			mode: 'find',
			dir: 'hn',
			object: 'comments',
			criteria: [{ field: 'by', op: 'eq', value: username }],
			order_by: { field: 'time', dir: 'desc' },
			limit: RECENT_LIMIT,
			format: 'dict'
		})
	]);

	const totalMs = performance.now() - t0;

	// User record — shard-db's `get` returns the bare object on hit, an error
	// dict on miss. We treat "not found" as "user is unknown but might still
	// have activity in our sample".
	let user: UserProfile | null = null;
	if (!isError(userResp)) {
		user = { key: username, ...(userResp as Omit<UserProfile, 'key'>) };
	}

	let stories: Story[] = [];
	let storiesError: string | undefined;
	if (isError(storiesResp)) {
		storiesError = storiesResp.error;
	} else {
		const dict = storiesResp as Record<string, Omit<Story, 'key'>>;
		stories = Object.entries(dict).map(([key, value]) => ({ key, ...value }));
	}

	let comments: Comment[] = [];
	let commentsError: string | undefined;
	if (isError(commentsResp)) {
		commentsError = commentsResp.error;
	} else {
		const dict = commentsResp as Record<string, Omit<Comment, 'key'>>;
		comments = Object.entries(dict).map(([key, value]) => ({ key, ...value }));
	}

	if (!user && stories.length === 0 && comments.length === 0) {
		throw error(404, `User '${username}' has no record or activity in our sample.`);
	}

	return {
		username,
		user,
		stories,
		comments,
		storiesError,
		commentsError,
		totalMs
	};
};
