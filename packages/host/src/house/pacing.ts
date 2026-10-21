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
