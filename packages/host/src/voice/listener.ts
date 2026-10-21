/**
 * The microphone, listening without a break: the browser's speech recognition, run continuously
 * and started again whenever it ends or fails. Chrome ends a session on its own after a stretch of
 * silence or a network hiccup, so ending is normal; only a refused microphone stops it for good.
 */

/**
 * How long to wait before starting again: soon after a normal end, then longer while it keeps
 * failing (250 ms, 500, 1 s, 2 s, 4 s), never more than 5 s.
 */
export function restartDelay(failures: number): number {
  return Math.min(5000, 250 * 2 ** Math.max(0, failures));
}
