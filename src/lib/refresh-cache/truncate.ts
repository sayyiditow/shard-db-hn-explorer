/** Byte-safe truncation for shard-db varchar:N inserts.
 *
 *  shard-db enforces N as the byte limit per record (UTF-8). Any
 *  insert with content longer than N bytes errors.  Caller must
 *  pre-truncate.  This helper:
 *
 *    - measures actual UTF-8 byte length (not char count)
 *    - reserves 3 bytes for an ellipsis ("...") so truncated
 *      content is visually flagged
 *    - backs off any byte cut that lands inside a multi-byte
 *      UTF-8 sequence (continuation bytes start `10xxxxxx`),
 *      so the result is always valid UTF-8
 *
 *  Returns the original string unchanged if it fits. */

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const ELLIPSIS = '...';

export function truncateBytes(s: string, maxBytes: number): string {
    if (!s) return s;
    const bytes = ENCODER.encode(s);
    if (bytes.length <= maxBytes) return s;

    const budget = maxBytes - ELLIPSIS.length;
    if (budget <= 0) {
        // Pathological — the limit is smaller than the ellipsis itself.
        // Fall back to a raw byte slice (best-effort, no ellipsis).
        let cut = maxBytes;
        while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
        return DECODER.decode(bytes.subarray(0, cut));
    }

    let cut = budget;
    while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
    return DECODER.decode(bytes.subarray(0, cut)) + ELLIPSIS;
}
