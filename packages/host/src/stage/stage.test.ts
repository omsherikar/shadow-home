import { describe, expect, test } from 'vitest';
import { LAYOUT_KEY, readLayout, writeLayout } from './stage.ts';

function memory() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    items,
  };
}

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
});
