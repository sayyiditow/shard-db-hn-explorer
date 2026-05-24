import { describe, test, expect } from 'bun:test';
import { truncateBytes } from './truncate';

describe('truncateBytes', () => {
    test('returns input unchanged when it fits', () => {
        expect(truncateBytes('hello', 10)).toBe('hello');
        expect(truncateBytes('hello', 5)).toBe('hello');
    });

    test('truncates ASCII at limit-3 + ellipsis', () => {
        const s = 'abcdefghij';        // 10 bytes
        expect(truncateBytes(s, 8)).toBe('abcde...');   // 5 + 3 = 8 bytes
        expect(truncateBytes(s, 6)).toBe('abc...');     // 3 + 3 = 6 bytes
    });

    test('does not split multi-byte UTF-8 mid-character', () => {
        // 'é' is 2 bytes in UTF-8 (0xC3 0xA9).
        const s = 'aaé';                                // 4 bytes
        // Limit 4 fits, no truncation.
        expect(truncateBytes(s, 4)).toBe('aaé');
        // Limit 3 forces truncation; budget = 0 (3 - 3 = 0); ellipsis fits as the whole string. Hmm wait, budget <= 0 path.
        // Limit 6 with content longer than 6 — let's test that next.
        const long = 'aaaaaaé';                         // 8 bytes (7 chars: 6 ASCII + 2-byte é)
        // Truncate to 7 bytes → budget = 4. cut starts at 4; bytes[4] = 'a' (0x61), not continuation. cut stays. Result: 'aaaa...' (7 bytes).
        expect(truncateBytes(long, 7)).toBe('aaaa...');
        // Truncate to 8 bytes → fits exactly, no truncation.
        expect(truncateBytes(long, 8)).toBe('aaaaaaé');
    });

    test('backs off a cut that lands on a UTF-8 continuation byte', () => {
        // 'é' = 0xC3 0xA9. If we'd cut at byte 1 (mid-é), we should retreat to byte 0.
        const s = 'aaaaéé';                             // 8 bytes (4 ASCII + 2 × 'é')
        // Truncate to 8 → fits, no change.
        expect(truncateBytes(s, 8)).toBe(s);
        // Truncate to 7 → budget = 4. bytes[4] = 0xC3 (lead byte of first é), not continuation. cut=4. Result: 'aaaa...' (7 bytes total).
        expect(truncateBytes(s, 7)).toBe('aaaa...');
        // Truncate to 6 → budget = 3. bytes[3] = 'a'. cut=3. Result: 'aaa...' (6 bytes).
        expect(truncateBytes(s, 6)).toBe('aaa...');
    });

    test('handles empty / undefined-ish input', () => {
        expect(truncateBytes('', 10)).toBe('');
    });

    test('pathological tiny limit just returns a raw byte slice', () => {
        // Limit smaller than ellipsis (3 bytes) — no room for "...".
        expect(truncateBytes('abcdef', 2)).toBe('ab');
        expect(truncateBytes('abcdef', 1)).toBe('a');
    });
});
