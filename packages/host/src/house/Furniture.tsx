'use client';

import { useLoader } from '@react-three/fiber';
import { useMemo } from 'react';
import type { Mesh, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { HouseLayout, Prop } from './layout.ts';

const deg = (d: number) => (d * Math.PI) / 180;

/**
 * The furniture and garage contents: CC0 models from public/house/models (see CREDITS.md), each
 * loaded once and placed as often as the layout asks. The files need no decoder: plain WebP
 * textures and quantized geometry, which three.js reads itself.
 */
export function Furniture({ layout }: { layout: HouseLayout }) {
  const urls = useMemo(() => [...new Set(layout.props.map((p) => p.model))], [layout]);
  const models = useLoader(GLTFLoader, urls);
  return (
    <>
      {layout.props.map((p) => {
        const model = models[urls.indexOf(p.model)];
        return model ? (
          <Placed key={`${p.model}@${p.x},${p.z}`} prop={p} scene={model.scene} />
        ) : null;
      })}
    </>
  );
}

function Placed({ prop, scene }: { prop: Prop; scene: Object3D }) {
  const object = useMemo(() => {
    const copy = scene.clone(true);
    copy.traverse((o) => {
      if ((o as Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return copy;
  }, [scene]);
  return (
    <primitive
      object={object}
      position={[prop.x, prop.y, prop.z]}
      rotation-y={deg(prop.facing)}
      scale={prop.scale}
    />
  );
}
