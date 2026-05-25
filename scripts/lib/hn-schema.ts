/**
 * Single source of truth for the HN explorer index lists.
 *
 * setup-schema.ts reads INDEX_LISTS to create objects with indexes
 * already declared. bulk-load.ts reads the same lists to drop indexes
 * before truncate-and-reload (load-then-index pattern, much faster at
 * full-HN scale) and re-add them after. Keeping the lists here means
 * the two scripts can't drift.
 *
 * If you add or remove an index in setup-schema.ts, update this file
 * too — bulk-load will silently skip indexes it doesn't know about,
 * and queries on those fields will fall back to full scan.
 */

export const INDEX_LISTS: Record<string, string[]> = {
	stories: [
		'by',
		'time',
		'score',
		'type',
		'dead',
		'deleted',
		'title:trigram',
		'by+time',
		'time+score',
		'type+time'
	],
	comments: [
		'by',
		'time',
		'parent',
		'story_root',
		'dead',
		'deleted',
		'by+time',
		'story_root+time'
	],
	users: ['karma', 'created']
};

/**
 * Strip the type suffix (`:trigram`, `:bitmap`) off an index entry so
 * we can pass just the field/composite name to add-index / remove-index.
 * `cmd_add_indexes` re-reads the type from index.conf; the wire payload
 * is field names only.
 */
export function indexFieldName(spec: string): string {
	const colon = spec.indexOf(':');
	return colon < 0 ? spec : spec.slice(0, colon);
}
