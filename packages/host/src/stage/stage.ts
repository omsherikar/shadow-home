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
