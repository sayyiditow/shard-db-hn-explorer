import { describe, test, expect } from 'bun:test';
import { badgeTone } from './timing-badge';

describe('badgeTone', () => {
	test('hot path (<10ms) → fast', () => {
		expect(badgeTone(0)).toBe('fast');
		expect(badgeTone(9.9)).toBe('fast');
	});

	test('fast but not hot (10–999ms) → good (green)', () => {
		expect(badgeTone(10)).toBe('good');
		expect(badgeTone(659)).toBe('good'); // the reported bug: 659ms was rendering red
		expect(badgeTone(999)).toBe('good');
	});

	test('1000–2000ms → mid (orange)', () => {
		expect(badgeTone(1000)).toBe('mid');
		expect(badgeTone(1500)).toBe('mid');
		expect(badgeTone(2000)).toBe('mid');
	});

	test('red is reserved for >2000ms', () => {
		expect(badgeTone(2001)).toBe('bad');
		expect(badgeTone(8625)).toBe('bad');
	});
});
