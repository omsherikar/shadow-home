import { afterEach, describe, expect, it, vi } from 'vitest';
import { rememberSuggestions, SUGGESTIONS_KEY, suggestionsShown } from './suggestions.ts';

function fakeStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (k) => items.get(k) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (k) => {
      items.delete(k);
    },
    setItem: (k, v) => {
      items.set(k, v);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the suggestions toggle', () => {
  it('shows them by default', () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() });
    expect(suggestionsShown()).toBe(true);
  });

  it('remembers hiding them, and showing them again', () => {
    const localStorage = fakeStorage();
    vi.stubGlobal('window', { localStorage });
    rememberSuggestions(false);
    expect(localStorage.getItem(SUGGESTIONS_KEY)).toBe('hidden');
    expect(suggestionsShown()).toBe(false);
    rememberSuggestions(true);
    expect(localStorage.getItem(SUGGESTIONS_KEY)).toBeNull();
    expect(suggestionsShown()).toBe(true);
  });

  it('shows them, and keeps going, when the storage throws', () => {
    const broken = fakeStorage();
    broken.getItem = () => {
      throw new Error('blocked');
    };
    broken.setItem = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('window', { localStorage: broken });
    expect(suggestionsShown()).toBe(true);
    expect(() => rememberSuggestions(false)).not.toThrow();
  });
});
