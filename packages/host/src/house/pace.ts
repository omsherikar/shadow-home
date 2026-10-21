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

const KEY = 'shadow-home/pace';
let known: Pace | undefined;

/** The pace found earlier in this session, or `unsure` before the first playback. */
export function sessionPace(): Pace {
  if (known) return known;
  try {
    const stored = sessionStorage.getItem(KEY);
    known = stored === 'animate' || stored === 'still' ? stored : 'unsure';
  } catch {
    known = 'unsure';
  }
  return known;
}

/** Keeps the pace for the rest of the session, so every later playback starts with it. */
export function rememberPace(pace: Exclude<Pace, 'unsure'>): void {
  known = pace;
  try {
    sessionStorage.setItem(KEY, pace);
  } catch {}
}
