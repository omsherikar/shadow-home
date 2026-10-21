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
  return webglRenderer(makeCanvas) !== null;
}

interface Context {
  RENDERER?: number;
  getExtension?(name: string): { loseContext?(): void; UNMASKED_RENDERER_WEBGL?: number } | null;
  getParameter?(name: number | undefined): unknown;
}

/**
 * What draws WebGL in this browser, by name ("ANGLE (Apple, ANGLE Metal Renderer: Apple M2…)",
 * "…SwiftShader driver)"; empty when the browser won't say), or null without WebGL. Like
 * `webglAvailable`, it hands the throwaway context straight back.
 */
export function webglRenderer(
  makeCanvas: () => CanvasLike = () => document.createElement('canvas'),
): string | null {
  try {
    const canvas = makeCanvas();
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as Context | null;
    if (!gl) return null;
    const info = gl.getExtension?.('WEBGL_debug_renderer_info');
    const name = gl.getParameter?.(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
    gl.getExtension?.('WEBGL_lose_context')?.loseContext?.();
    return typeof name === 'string' ? name : '';
  } catch {
    return null;
  }
}
