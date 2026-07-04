import { REFRESH_INTERVAL_MINUTES } from '$lib/refresh-cache';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => {
	return { refreshIntervalMinutes: REFRESH_INTERVAL_MINUTES };
};
