<!--
  Showcase signature visual. Drop it next to any rendered result to
  show the query latency that produced it.

  Usage:
    <TimingBadge ms={data.queryMs} />
    <TimingBadge ms={data.queryMs} label="search" />

  Colour cue (red reserved for genuinely slow queries):
    <   10ms  → fast    (vivid green — shard-db hot path)
    <  1000ms  → good    (green)
    1000–2000ms → mid    (orange)
    >  2000ms  → bad     (red)
  Thresholds live in ./timing-badge.ts (badgeTone) and are unit-tested.
-->
<script lang="ts">
	import { badgeTone } from './timing-badge';

	interface Props {
		ms: number;
		label?: string;
	}
	let { ms, label }: Props = $props();

	let tone = $derived(badgeTone(ms));

	let display = $derived(
		ms < 1   ? ms.toFixed(2) + ' ms' :
		ms < 100 ? ms.toFixed(1) + ' ms' :
		           Math.round(ms) + ' ms'
	);
</script>

<span class="badge {tone}" title={label ? `${label}: ${ms.toFixed(2)} ms` : `${ms.toFixed(2)} ms`}>
	<span class="bracket left">[</span>
	<span class="num">{display}</span>
	<span class="bracket right">]</span>
	{#if label}<span class="label">{label}</span>{/if}
</span>

<style>
	.badge {
		display: inline-flex;
		align-items: baseline;
		gap: 0.3em;
		font-family: var(--f-mono);
		font-size: 0.8rem;
		padding: 0.15em 0.5em;
		border-radius: var(--r-sm);
		background: var(--c-surface-2);
		line-height: 1.3;
		font-variant-numeric: tabular-nums;
	}
	.bracket { color: var(--c-text-faint); }
	.num { font-weight: 600; }
	.label { color: var(--c-text-muted); font-size: 0.75rem; }

	.badge.fast .num { color: var(--c-good); }
	.badge.fast .bracket { color: var(--c-good); opacity: 0.5; }
	.badge.good .num { color: var(--c-good); }
	.badge.mid .num { color: var(--c-mid); }
	.badge.bad .num { color: var(--c-warn); }
</style>
