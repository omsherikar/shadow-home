import { describe, expect, test, vi } from 'vitest';
import { webglAvailable, webglRenderer } from './webgl.ts';

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

describe('what draws WebGL', () => {
  const RENDERER = 0x1f01;
  const UNMASKED = 0x9246;
  const context = (debugInfo: boolean, loseContext = vi.fn()) => ({
    RENDERER,
    getExtension: (name: string) =>
      name === 'WEBGL_debug_renderer_info'
        ? debugInfo
          ? { UNMASKED_RENDERER_WEBGL: UNMASKED }
          : null
        : { loseContext },
    getParameter: (p: number) =>
      p === UNMASKED
        ? 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)'
        : 'WebKit WebGL',
  });

  test('is the unmasked name where the browser gives it, and the context goes back', () => {
    const loseContext = vi.fn();
    const gl = context(true, loseContext);
    expect(webglRenderer(() => ({ getContext: () => gl }))).toMatch(/SwiftShader/);
    expect(loseContext).toHaveBeenCalledOnce();
  });

  test('is the plain name where it doesn’t, and empty where there’s no name at all', () => {
    expect(webglRenderer(() => ({ getContext: () => context(false) }))).toBe('WebKit WebGL');
    expect(
      webglRenderer(() => ({ getContext: (kind: string) => (kind === 'webgl' ? {} : null) })),
    ).toBe('');
  });

  test('is nothing without WebGL', () => {
    expect(webglRenderer(() => ({ getContext: () => null }))).toBeNull();
  });
});
