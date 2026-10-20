/**
 * The page around the device: which layout the person chose, and what the verdict chip says.
 * Pure functions, so they can be tested without a browser.
 */

/** Split: the house beside the device. House: the house alone, the device tucked away. */
export type Layout = 'split' | 'house';

export const LAYOUT_KEY = 'shadow-home/layout';

/** The layout chosen last time. Storage can be missing or refuse (a private window): split. */
export function readLayout(storage: Pick<Storage, 'getItem'> | null): Layout {
  try {
    return storage?.getItem(LAYOUT_KEY) === 'house' ? 'house' : 'split';
  } catch {
    return 'split';
  }
}

/** Remember the choice; if storage refuses, it lasts until the page reloads. */
export function writeLayout(storage: Pick<Storage, 'setItem'> | null, layout: Layout): void {
  try {
    storage?.setItem(LAYOUT_KEY, layout);
  } catch {
    // Nothing to do: the choice still holds for this visit.
  }
}

/** The browser's local storage, or null where reading it throws. */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
