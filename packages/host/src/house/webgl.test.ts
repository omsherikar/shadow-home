import { describe, expect, test, vi } from 'vitest';
import { webglAvailable } from './webgl.ts';

describe('whether the browser can draw the house', () => {
  test('yes with WebGL 2, and it hands the context back', () => {
    const loseContext = vi.fn();
    const canvas = {
      getContext: (kind: string) =>
        kind === 'webgl2' ? { getExtension: () => ({ loseContext }) } : null,
    };
    expect(webglAvailable(() => canvas)).toBe(true);
    expect(loseContext).toHaveBeenCalledOnce();
  });

  test('yes with WebGL 1 alone', () => {
    const canvas = { getContext: (kind: string) => (kind === 'webgl' ? {} : null) };
    expect(webglAvailable(() => canvas)).toBe(true);
  });

  test('no when the browser gives no context', () => {
    expect(webglAvailable(() => ({ getContext: () => null }))).toBe(false);
  });

  test('no when asking throws', () => {
    expect(
      webglAvailable(() => {
        throw new Error('blocked');
      }),
    ).toBe(false);
  });
});
