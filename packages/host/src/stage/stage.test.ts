import { describe, expect, test } from 'vitest';
import {
  chipFor,
  clampSize,
  DEFAULT_SIZES,
  dayAndTime,
  dragSize,
  keySize,
  LAYOUT_KEY,
  parseSizes,
  readLayout,
  readSizes,
  SIZES_KEY,
  writeLayout,
  writeSizes,
} from './stage.ts';

function memory() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    items,
  };
}

const refusing = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
};

describe('the layout choice', () => {
  test('starts split, and comes back as it was left', () => {
    const storage = memory();
    expect(readLayout(storage)).toBe('split');
    writeLayout(storage, 'house');
    expect(storage.items.get(LAYOUT_KEY)).toBe('house');
    expect(readLayout(storage)).toBe('house');
    writeLayout(storage, 'split');
    expect(readLayout(storage)).toBe('split');
  });

  test('anything else stored, no storage, or storage that refuses, reads as split', () => {
    const storage = memory();
    storage.setItem(LAYOUT_KEY, 'sideways');
    expect(readLayout(storage)).toBe('split');
    expect(readLayout(null)).toBe('split');
    expect(readLayout(refusing)).toBe('split');
    expect(() => writeLayout(refusing, 'house')).not.toThrow();
  });
});

describe('the split sizes', () => {
  test('the house keeps 25 to 70% of the width, the screen 30 to 75% of its column', () => {
    expect(clampSize('house', 10)).toBe(25);
    expect(clampSize('house', 90)).toBe(70);
    expect(clampSize('house', 47.26)).toBe(47.3);
    expect(clampSize('screen', 0)).toBe(30);
    expect(clampSize('screen', 100)).toBe(75);
    expect(clampSize('screen', Number.NaN)).toBe(DEFAULT_SIZES.screen);
  });

  test('start at the defaults, and come back as they were left', () => {
    const storage = memory();
    expect(readSizes(storage)).toEqual({ house: 40, screen: 56 });
    writeSizes(storage, { house: 55, screen: 40 });
    expect(JSON.parse(storage.items.get(SIZES_KEY) ?? '')).toEqual({ house: 55, screen: 40 });
    expect(readSizes(storage)).toEqual({ house: 55, screen: 40 });
  });

  test('broken, partial or out-of-range sizes read as the defaults or are held to range', () => {
    expect(parseSizes('not json')).toEqual(DEFAULT_SIZES);
    expect(parseSizes('{"house":"wide"}')).toEqual(DEFAULT_SIZES);
    expect(parseSizes('[1,2]')).toEqual(DEFAULT_SIZES);
    expect(parseSizes('{"house":99}')).toEqual({ house: 70, screen: DEFAULT_SIZES.screen });
    expect(parseSizes('{"screen":5}')).toEqual({ house: DEFAULT_SIZES.house, screen: 30 });
    expect(readSizes(null)).toEqual(DEFAULT_SIZES);
    expect(readSizes(refusing)).toEqual(DEFAULT_SIZES);
    expect(() => writeSizes(refusing, DEFAULT_SIZES)).not.toThrow();
  });

  test('a drag moves a boundary by its share of the length, within range', () => {
    expect(dragSize('house', 40, 144, 1440)).toBe(50);
    expect(dragSize('house', 40, -1440, 1440)).toBe(25);
    expect(dragSize('screen', 56, 86, 860)).toBe(66);
    expect(dragSize('screen', 56, 30, 0)).toBe(56);
  });

  test('arrow keys move a boundary 2% at a time; Home and End go to its ends', () => {
    expect(keySize('house', 40, 'ArrowLeft')).toBe(38);
    expect(keySize('house', 40, 'ArrowRight')).toBe(42);
    expect(keySize('screen', 56, 'ArrowUp')).toBe(54);
    expect(keySize('screen', 56, 'ArrowDown')).toBe(58);
    expect(keySize('house', 69, 'ArrowRight')).toBe(70);
    expect(keySize('screen', 31, 'ArrowUp')).toBe(30);
    expect(keySize('house', 40, 'Home')).toBe(25);
    expect(keySize('screen', 40, 'End')).toBe(75);
    expect(keySize('house', 40, 'Enter')).toBeNull();
  });
});

describe('the verdict chip', () => {
  test('a preview shows its verdict', () => {
    expect(chipFor('preview_plan', { verdict: 'UNSAFE' })).toBe('UNSAFE');
    expect(chipFor('preview_plan', { verdict: 'SAFE' })).toBe('SAFE');
  });

  test('an undo shows its preview’s verdict', () => {
    expect(chipFor('undo', { status: 'preview', preview: { verdict: 'SAFE' } })).toBe('SAFE');
    expect(chipFor('undo', { status: 'nothing_to_undo' })).toBeUndefined();
  });

  test('a commit shows done, or the verdict of the fresh preview it was refused with', () => {
    expect(chipFor('commit_plan', { status: 'committed' })).toBe('DONE');
    expect(
      chipFor('commit_plan', { status: 'refused', freshPreview: { verdict: 'UNPROVEN' } }),
    ).toBe('UNPROVEN');
    expect(chipFor('commit_plan', { status: 'needs_confirmation' })).toBeUndefined();
  });

  test('other tools leave it as it was', () => {
    expect(chipFor('get_home_state', { verdict: 'SAFE' })).toBeUndefined();
    expect(chipFor('preview_plan', undefined)).toBeUndefined();
  });
});

test('the home’s time reads as its own clock, with the day spelled out', () => {
  expect(dayAndTime('2027-01-15T17:45:00-06:00')).toBe('Friday, 5:45 PM');
  expect(dayAndTime('2027-01-17T00:05:00-06:00')).toBe('Sunday, 12:05 AM');
  expect(dayAndTime('not a time')).toBe('');
});
