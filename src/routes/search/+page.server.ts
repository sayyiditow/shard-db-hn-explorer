import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Legacy /search route. The unified browse + search page lives at /,
 * and the home page's filter-pills UI subsumes everything /search
 * used to do (and adds type/sort/window/by/cursor pagination on top).
 *
 * Forward old links by redirecting to / with the same ?q=. Status 308
 * preserves the GET method and tells the browser this is permanent
 * (good for cached bookmarks). q falls back to empty → /'s browse
 * mode shows top stories instead of erroring.
 */
export const load: PageServerLoad = async ({ url }) => {
	const q = url.searchParams.get('q') ?? '';
	const target = q ? `/?q=${encodeURIComponent(q)}` : '/';
	throw redirect(308, target);
};
