/** Display helpers for HN items. Server- and client-safe. */

/** "3 hours ago", "2 days ago", "just now" — coarse-grained, good enough for a list. */
export function relativeTime(unixSeconds: number, now: Date = new Date()): string {
	const deltaSec = Math.max(0, Math.floor(now.getTime() / 1000 - unixSeconds));
	if (deltaSec < 60) return 'just now';
	if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
	if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
	if (deltaSec < 30 * 86400) return `${Math.floor(deltaSec / 86400)}d ago`;
	if (deltaSec < 365 * 86400) return `${Math.floor(deltaSec / (30 * 86400))}mo ago`;
	return `${Math.floor(deltaSec / (365 * 86400))}y ago`;
}

/** Exact yyyy-mm-dd hh:mm for tooltips / "absolute time on hover" */
export function absoluteTime(unixSeconds: number): string {
	if (!unixSeconds) return '';
	const d = new Date(unixSeconds * 1000);
	return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** Strip HN's HTML formatting from a comment body for plain-text snippets.
 *  Keeps the result safe to render inside a text node. Use this for
 *  search-result previews; full thread views should render the HTML
 *  via a sanitiser instead. */
export function commentSnippet(html: string, maxChars = 220): string {
	if (!html) return '';
	const plain = html
		.replace(/<p>/gi, ' ')
		.replace(/<br\s*\/?>/gi, ' ')
		.replace(/<i>([^<]*)<\/i>/gi, '$1')
		.replace(/<[^>]+>/g, '')
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#x2F;/g, '/')
		.replace(/\s+/g, ' ')
		.trim();
	if (plain.length <= maxChars) return plain;
	return plain.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
}

/** Domain extracted from a URL — for trending / story footers. */
export function domainOf(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, '');
	} catch {
		return null;
	}
}

/** HN's own URL for a given item id — for "see on HN" links. */
export function hnItemUrl(id: number | string): string {
	return `https://news.ycombinator.com/item?id=${id}`;
}

/** HN's own URL for a user. */
export function hnUserUrl(username: string): string {
	return `https://news.ycombinator.com/user?id=${encodeURIComponent(username)}`;
}

/** Pluralise a count: pluralise(1,'comment') -> '1 comment'. */
export function pluralise(n: number, singular: string, plural?: string): string {
	const p = plural ?? `${singular}s`;
	return `${n.toLocaleString()} ${n === 1 ? singular : p}`;
}
