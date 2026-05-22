import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /jobs route. The unified browse UI on / handles jobs via
 * ?type=job — same cursor pagination, same filter pills. Redirect
 * so the URL is just a shortcut and we keep one implementation.
 * `sort=newest` matches HN's own jobs page which is chronological,
 * not popularity-ranked. 308 = permanent + preserves GET method.
 */
export const load: PageServerLoad = async () => {
	throw redirect(308, '/?type=job&sort=newest');
};
