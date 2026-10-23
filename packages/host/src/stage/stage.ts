/**
 * The page around the device: which layout the person chose, how they sized it, and what the
 * verdict chip says. Pure functions, so they can be tested without a browser.
 */

import { z } from 'zod';

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

/**
 * How the split is sized, in percent: the house's share of the page's width, and the screen's share
 * of the column beside it (the chat has the rest). The person drags the boundaries to change them.
 */
export interface Sizes {
  house: number;
  screen: number;
}

export const SIZES_KEY = 'shadow-home/sizes';

/** The split as it first opens: the house on 40% of the width, the screen a little over half. */
export const DEFAULT_SIZES: Sizes = { house: 40, screen: 56 };

/** How far each boundary goes. */
export const SIZE_RANGES: Record<keyof Sizes, { min: number; max: number }> = {
  house: { min: 25, max: 70 },
  screen: { min: 30, max: 75 },
};

/** One arrow key press moves a boundary this many percent. */
export const SIZE_STEP = 2;

/** A size held to its range, to a tenth of a percent. Anything not a number is the default. */
export function clampSize(which: keyof Sizes, value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SIZES[which];
  const { min, max } = SIZE_RANGES[which];
  return Math.min(max, Math.max(min, Math.round(value * 10) / 10));
}

const storedSizes = z.object({ house: z.number().optional(), screen: z.number().optional() });

/** Sizes from what storage held: whatever is missing or broken is the default, the rest is held. */
export function parseSizes(raw: string | null): Sizes {
  if (raw === null) return { ...DEFAULT_SIZES };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SIZES };
  }
  const parsed = storedSizes.safeParse(json);
  if (!parsed.success) return { ...DEFAULT_SIZES };
  return {
    house: clampSize('house', parsed.data.house ?? DEFAULT_SIZES.house),
    screen: clampSize('screen', parsed.data.screen ?? DEFAULT_SIZES.screen),
  };
}

/** The sizes left last time. Storage can be missing or refuse: the defaults. */
export function readSizes(storage: Pick<Storage, 'getItem'> | null): Sizes {
  try {
    return parseSizes(storage?.getItem(SIZES_KEY) ?? null);
  } catch {
    return { ...DEFAULT_SIZES };
  }
}

/** Remember the sizes; if storage refuses, they last until the page reloads. */
export function writeSizes(storage: Pick<Storage, 'setItem'> | null, sizes: Sizes): void {
  try {
    storage?.setItem(SIZES_KEY, JSON.stringify(sizes));
  } catch {
    // Nothing to do: the sizes still hold for this visit.
  }
}

/** Where a drag takes a boundary: `moved` pixels along a length of `span` pixels for 100%. */
export function dragSize(which: keyof Sizes, start: number, moved: number, span: number): number {
  return clampSize(which, span > 0 ? start + (moved / span) * 100 : start);
}

/**
 * Where a key press takes a boundary, or null for a key it doesn't answer. Left and up shrink the
 * house or the screen, right and down grow it; Home and End go to the ends of its range.
 */
export function keySize(which: keyof Sizes, value: number, key: string): number | null {
  if (key === 'ArrowLeft' || key === 'ArrowUp') return clampSize(which, value - SIZE_STEP);
  if (key === 'ArrowRight' || key === 'ArrowDown') return clampSize(which, value + SIZE_STEP);
  if (key === 'Home') return SIZE_RANGES[which].min;
  if (key === 'End') return SIZE_RANGES[which].max;
  return null;
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
