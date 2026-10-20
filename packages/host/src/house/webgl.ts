interface CanvasLike {
  getContext(kind: string): unknown;
}

/**
 * Whether this browser can draw the house. It asks a throwaway canvas for a WebGL context and
 * gives the context straight back, so the check doesn't hold one of the browser's few.
 */
export function webglAvailable(
  makeCanvas: () => CanvasLike = () => document.createElement('canvas'),
): boolean {
  try {
    const canvas = makeCanvas();
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as {
      getExtension?(name: string): { loseContext?(): void } | null;
    } | null;
    if (!gl) return false;
    gl.getExtension?.('WEBGL_lose_context')?.loseContext?.();
    return true;
  } catch {
    return false;
  }
}
