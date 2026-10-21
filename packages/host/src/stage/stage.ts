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

export type Chip = 'SAFE' | 'UNSAFE' | 'UNPROVEN' | 'DONE';

/**
 * Icon, word and tone for each chip, as the plan view shows them. The verdicts stay SAFE, UNSAFE
 * and UNPROVEN in the data; on screen they read as a person would say them.
 */
export const CHIPS: Record<Chip, { icon: string; word: string; tone: string }> = {
  SAFE: { icon: '✓', word: 'Safe', tone: 'safe' },
  UNSAFE: { icon: '✕', word: 'Not safe', tone: 'blocked' },
  UNPROVEN: { icon: '?', word: "Can't confirm", tone: 'unsure' },
  DONE: { icon: '✓', word: 'Done', tone: 'done' },
};

const verdict = (v: unknown): Chip | undefined =>
  v === 'SAFE' || v === 'UNSAFE' || v === 'UNPROVEN' ? v : undefined;

/**
 * What a tool result puts on the verdict chip: the verdict of the preview it carries, or DONE once
 * a plan is committed. Anything else leaves the chip as it was.
 */
export function chipFor(
  tool: string,
  result: Record<string, unknown> | undefined,
): Chip | undefined {
  if (!result) return undefined;
  const inner = (key: string) => (result[key] as { verdict?: unknown } | undefined)?.verdict;
  if (tool === 'preview_plan') return verdict(result.verdict);
  if (tool === 'undo') return verdict(inner('preview'));
  if (tool === 'commit_plan') {
    return result.status === 'committed' ? 'DONE' : verdict(inner('freshPreview'));
  }
  return undefined;
}

/** "Friday, 5:45 PM" from the home's ISO time, read as the home's own clock. */
export function dayAndTime(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return '';
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
  ];
  return `${day}, ${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
