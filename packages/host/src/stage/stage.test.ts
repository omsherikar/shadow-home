import { describe, expect, test } from 'vitest';
import { chipFor, LAYOUT_KEY, readLayout, writeLayout } from './stage.ts';

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
