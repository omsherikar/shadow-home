'use client';

import { useLoader } from '@react-three/fiber';
import { useMemo } from 'react';
import type { Mesh, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { HouseLayout, Prop } from './layout.ts';
import { palette } from './palette.ts';

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

/** The household as simple figures, in the house when they're home. */
export function People({
  layout,
  presence,
}: {
  layout: HouseLayout;
  presence: Record<string, 'home' | 'away'> | undefined;
}) {
  return (
    <>
      {layout.people
        .filter((p) => presence?.[p.member] === 'home')
        .map((p) => (
          <group
            key={p.member}
            name={p.member}
            position={[p.x, 0, p.z]}
            rotation-y={deg(p.facing)}
            scale={p.scale}
          >
            <mesh position={[0, 0.62, 0]} castShadow>
              <capsuleGeometry args={[0.17, 0.85, 6, 16]} />
              <meshStandardMaterial color={p.color} roughness={0.8} />
            </mesh>
            <mesh position={[0, 1.37, 0]} castShadow>
              <sphereGeometry args={[0.13, 24, 16]} />
              <meshStandardMaterial color={palette.skin} roughness={0.7} />
            </mesh>
          </group>
        ))}
    </>
  );
}
