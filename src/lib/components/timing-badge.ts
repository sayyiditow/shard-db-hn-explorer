export type BadgeTone = 'fast' | 'good' | 'mid' | 'bad';

/** Map a query latency (ms) to a colour tone for TimingBadge.
 *
 * Red ('bad') is reserved for >2000ms — a genuinely slow query worth noticing.
 * Everything at or under 1s reads green; the <10ms hot-path keeps a brighter
 * accent so "served from shard-db's fast path" still pops.
 *
 *    <10ms        → fast (vivid green, hot path)
 *    10–999ms     → good (green)
 *    1000–2000ms  → mid  (orange)
 *    >2000ms      → bad  (red)
 */
export function badgeTone(ms: number): BadgeTone {
	if (ms < 10) return 'fast';
	if (ms < 1000) return 'good';
	if (ms <= 2000) return 'mid';
	return 'bad';
}
