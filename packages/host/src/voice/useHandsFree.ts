import { type HandsFree, hears } from './machine.ts';

/**
 * Whether the microphone should listen: in a state that listens, and only while the page is in
 * view, so a hidden tab sends nothing to be recognised.
 */
export function shouldListen(state: HandsFree, visible: boolean): boolean {
  return visible && hears(state.mode);
}
