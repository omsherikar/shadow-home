/**
 * How fast a run's clock goes in the house: slow near the moments worth watching (a change, a
 * rule breaking, someone leaving), slower through dusk and dawn so the sky fades rather than
 * flips, and quick through the quiet hours between. Pure: the same run always plays at the same
 * pace, and the clock still shows the engine's own times; only how long each hour takes on screen
 * changes.
 */

const MINUTE_MS = 60_000;

/** A moment the clock slows down for. */
export interface Anchor {
  atMs: number;
  /** How far either side of it the clock is slowed, in home milliseconds. */
  reachMs: number;
  /** The clock's speed at the moment itself, as a share of its speed in the quiet hours. */
  speed: number;
}

/** Near a change, a rule breaking or someone leaving: about seven times slower. */
export const NEAR_EVENT = { reachMs: 80 * MINUTE_MS, speed: 1 / 7 } as const;
/** Through dusk and dawn: about three times slower, so the sky takes a second or so to turn. */
export const NEAR_TWILIGHT = { reachMs: 75 * MINUTE_MS, speed: 1 / 3 } as const;

/** The clock's speed at a home time, as a share of its speed in the quiet hours (1). */
export function speedAt(anchors: Anchor[], atMs: number): number {
  let speed = 1;
  for (const a of anchors) {
    const d = Math.abs(atMs - a.atMs) / a.reachMs;
    if (d >= 1) continue;
    // Full slowdown at the moment, easing back to full speed at the edge of its reach.
    const near = 1 - d * d * (3 - 2 * d);
    speed = Math.min(speed, 1 - (1 - a.speed) * near);
  }
  return speed;
}

/** A slice of home time and the real time each home millisecond in it takes. */
export interface PaceSlice {
  fromMs: number;
  toMs: number;
  /** Real milliseconds per home millisecond. */
  rate: number;
}

/** Slices of ten home minutes, or longer for a run of more than about four days. */
const SLICE_MS = 10 * MINUTE_MS;
const MOST_SLICES = 600;

/**
 * The real time each part of a run's clock takes, slice by slice from `startMs` to `endMs`,
 * scaled so the whole run takes `totalMs`.
 */
export function paceSlices(
  startMs: number,
  endMs: number,
  anchors: Anchor[],
  totalMs: number,
): PaceSlice[] {
  const span = endMs - startMs;
  if (!(span > 0)) return [];
  const size = Math.max(SLICE_MS, span / MOST_SLICES);
  const slices: PaceSlice[] = [];
  for (let from = startMs; from < endMs; from += size) {
    const to = Math.min(endMs, from + size);
    slices.push({ fromMs: from, toMs: to, rate: 1 / speedAt(anchors, (from + to) / 2) });
  }
  const weight = slices.reduce((sum, s) => sum + s.rate * (s.toMs - s.fromMs), 0);
  const k = totalMs / weight;
  return slices.map((s) => ({ ...s, rate: s.rate * k }));
}
