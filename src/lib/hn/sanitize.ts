/** Minimal HTML sanitiser for HN comment bodies.
 *
 *  HN comments use a restricted HTML subset: <p>, <i>, <a href>, <pre><code>.
 *  Everything else is plain text (with &-entities). We don't accept user
 *  HTML in our own UI — comments come straight from HN's API, which is
 *  already curated — but we still strip-out anything not on the allowlist
 *  before rendering with {@html}.
 *
 *  This is intentionally NOT a general-purpose sanitiser. For this
 *  showcase the input shape is bounded by HN's own rules. */

const ALLOWED_TAGS = new Set(['p', 'i', 'em', 'b', 'strong', 'br', 'pre', 'code', 'a']);
const ALLOWED_ATTRS_BY_TAG: Record<string, Set<string>> = {
	a: new Set(['href', 'rel', 'target'])
};
const URL_OK = /^(https?:|mailto:|\/)/i;

export function sanitiseHnHtml(html: string): string {
	if (!html) return '';

	// Strip <script>, <style>, <iframe>, <object>, <embed> in their entirety
	// (HN never produces these but defence-in-depth costs little).
	const stripped = html.replace(/<(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, '');

	return stripped.replace(/<\/?([a-z][a-z0-9]*)([^>]*)>/gi, (match, rawTag, rawAttrs) => {
		const tag = rawTag.toLowerCase();
		const closing = match.startsWith('</');
		if (!ALLOWED_TAGS.has(tag)) {
			// Drop the tag entirely; preserve nothing.
			return '';
		}
		if (closing) return `</${tag}>`;
		const allowedAttrs = ALLOWED_ATTRS_BY_TAG[tag];
		if (!allowedAttrs) return `<${tag}>`;

		// Parse `key="value"` and `key='value'` pairs, drop anything else.
		const kept: string[] = [];
		const attrRe = /([a-z\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
		let m: RegExpExecArray | null;
		while ((m = attrRe.exec(rawAttrs)) !== null) {
			const key = m[1].toLowerCase();
			if (!allowedAttrs.has(key)) continue;
			const value = m[2] ?? m[3] ?? '';
			if (key === 'href' && !URL_OK.test(value)) continue;
			kept.push(`${key}="${escapeAttr(value)}"`);
		}
		// Always add rel + target=_blank on <a> for safety + UX
		if (tag === 'a') {
			if (!kept.some((s) => s.startsWith('rel=')))    kept.push('rel="noopener nofollow"');
			if (!kept.some((s) => s.startsWith('target='))) kept.push('target="_blank"');
		}
		return kept.length ? `<${tag} ${kept.join(' ')}>` : `<${tag}>`;
	});
}

function escapeAttr(s: string): string {
	return s.replace(/[&"<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
