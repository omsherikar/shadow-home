/**
 * Whether this machine draws the house fast enough to play a plan forward. On a slow renderer
 * (software WebGL, a weak laptop) each frame holds the page for a second or more, and the device
 * beside the house waits with it; there the house shows where each run ends instead, as it does
 * when the person asks for less motion.
 */

/**
 * Longer than this between frames, the sweep shows fewer than seven frames a second and the page
 * waits that long between anything else it has to do. A GPU draws the house in about 17 ms (one
 * display refresh); software WebGL in CI takes 1.2 to 2.8 s.
 */
export const SLOW_FRAME_MS = 150;

export type Pace = 'animate' | 'still' | 'unsure';

/**
 * The pace for a playback, from the gaps between its first frames, in milliseconds. The first gap
 * is left out: it can carry one-off work (shaders built for the twin). Two gaps after it over four
 * times the limit settle it at once, so a slow machine spends as few frames as it can finding out;
 * otherwise the middle of the next three decides.
 */
export function paceFrom(gapsMs: number[]): Pace {
  const judged = gapsMs.slice(1);
  if (judged.length >= 2 && judged.slice(0, 2).every((ms) => ms > SLOW_FRAME_MS * 4)) {
    return 'still';
  }
  if (judged.length < 3) return 'unsure';
  const middle = judged
    .slice(0, 3)
    .sort((a, b) => a - b)
    .at(1);
  return middle !== undefined && middle > SLOW_FRAME_MS ? 'still' : 'animate';
}

/**
 * Whether a WebGL renderer draws on the CPU: SwiftShader (Chrome without a GPU, as in CI),
 * llvmpipe and the like. There every frame takes a second or more, so the house doesn't sweep.
 */
export function drawsInSoftware(renderer: string): boolean {
  return /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/i.test(renderer);
}

/**
 * How far one playback has got in finding its pace: the gaps between its frames so far, and what
 * they say. Every playback starts afresh, so one slow start (a shader being built, a recording
 * starting) costs only that playback its sweep.
 */
export interface Judging {
  gapsMs: number[];
  pace: Pace;
}

export const NEW_PLAYBACK: Judging = { gapsMs: [], pace: 'unsure' };

/** One more frame of a playback. Once its pace is found, later frames don't change it. */
export function judge(judging: Judging, gapMs: number): Judging {
  if (judging.pace !== 'unsure') return judging;
  const gapsMs = [...judging.gapsMs, gapMs];
  return { gapsMs, pace: paceFrom(gapsMs) };
}

/**
 * One more frame of a playback, judged by what it drew. Frames while the clock runs draw the most
 * (the sun and sky move, every room's colour changes, shadows are drawn again), so they decide
 * whether it can sweep; frames while the house acts out the plan or stops on a break draw less
 * and count only when they're far too slow (over four times the limit), so a slow machine still
 * finds out within its first few frames.
 */
export function judgeFrame(judging: Judging, gapMs: number, sweeping: boolean): Judging {
  return sweeping || gapMs > SLOW_FRAME_MS * 4 ? judge(judging, gapMs) : judging;
}

/**
 * Whether a playback shows where each run ends instead of sweeping: always with less motion asked
 * for or on software WebGL (known from the renderer's name on every load), and otherwise when its
 * own first frames were too slow.
 */
export function showsEnds(pace: Pace, still: boolean, software: boolean): boolean {
  return still || software || pace === 'still';
}
