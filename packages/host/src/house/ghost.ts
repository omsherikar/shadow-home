import type { Material } from 'three';

/**
 * The shadow twin: while a plan plays, the house takes a cool blue cast, keeping its own colours,
 * materials, light and shade underneath, so the run reads as a dry run on a copy of the home and
 * still looks like the home. One uniform drives every material that takes part, from 0 (the real
 * house) to 1 (the twin).
 */
export const ghost = { value: 0 };

const PATCHED = Symbol('ghost');

/** How far the twin's blue goes over each material's own colour. */
export const TWIN_CAST = 0.32;

/**
 * Let a material fade into the twin: its colour blends part way towards a blue of the same
 * brightness as `ghost` rises. Safe to call on the same material more than once.
 */
export function ghostly(material: Material | null): void {
  if (!material || (material as unknown as Record<symbol, boolean>)[PATCHED]) return;
  (material as unknown as Record<symbol, boolean>)[PATCHED] = true;
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.uniforms.uGhost = ghost;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uGhost;\nvoid main() {')
      .replace(
        '#include <dithering_fragment>',
        [
          '#include <dithering_fragment>',
          'float ghostLight = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));',
          'vec3 ghostTone = mix(vec3(0.07, 0.12, 0.2), vec3(0.6, 0.78, 1.0), clamp(ghostLight * 1.8, 0.0, 1.0));',
          `gl_FragColor.rgb = mix(gl_FragColor.rgb, ghostTone, uGhost * ${TWIN_CAST.toFixed(2)});`,
        ].join('\n'),
      );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|ghost`;
  material.needsUpdate = true;
}
