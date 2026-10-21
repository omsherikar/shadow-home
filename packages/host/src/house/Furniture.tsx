'use client';

import { useFrame, useLoader, useThree } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef } from 'react';
import type { Group, Material, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ghostly } from './ghost.ts';
import type { HouseLayout, Prop } from './layout.ts';
import { palette } from './palette.ts';
import { along, type Point, routeOut } from './walk.ts';

const deg = (d: number) => (d * Math.PI) / 180;

/**
 * The furniture and garage contents: CC0 models from public/house/models (see CREDITS.md), each
 * loaded once and placed as often as the layout asks. The files need no decoder: plain WebP
 * textures and quantized geometry, which three.js reads itself.
 */
export const Furniture = memo(function Furniture({ layout }: { layout: HouseLayout }) {
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
});

function Placed({ prop, scene }: { prop: Prop; scene: Object3D }) {
  const object = useMemo(() => {
    const copy = scene.clone(true);
    copy.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const tint = prop.tint;
      const own = (m: Material) => {
        if (!tint) return m;
        // This copy only: other placements of the same model keep its own colours.
        const c = m.clone() as MeshStandardMaterial;
        c.color.set(tint.color).multiplyScalar(tint.lighten);
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
      for (const m of [mesh.material].flat()) ghostly(m);
    });
    return copy;
  }, [scene, prop.tint]);
  return (
    <primitive
      object={object}
      position={[prop.x, prop.y, prop.z]}
      rotation-y={deg(prop.facing)}
      scale={prop.scale}
    />
  );
}

/** How long, in real time, someone takes to walk out of the front door or back in. */
const WALK_MS = 1600;

/**
 * The household as simple figures, in the house when they're home. When the presence the check
 * used says someone leaves, they walk out of the front door (and back in when they come home),
 * unless the house is still: then they're simply there or not.
 */
export const People = memo(function People({
  layout,
  presence,
  still,
}: {
  layout: HouseLayout;
  presence: Record<string, 'home' | 'away'> | undefined;
  still: boolean;
}) {
  return (
    <>
      {layout.people.map((p) => (
        <Person
          key={p.member}
          person={p}
          route={routeOut(layout, p.member)}
          home={presence?.[p.member] === 'home'}
          still={still}
        />
      ))}
    </>
  );
});

function Person(props: {
  person: HouseLayout['people'][number];
  route: Point[];
  home: boolean;
  still: boolean;
}) {
  const { person, route, home, still } = props;
  const group = useRef<Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  // A walk under way: out of the door or back in, from when (on the page's clock).
  const walk = useRef<{ out: boolean; since: number } | null>(null);
  const was = useRef(home);
  useEffect(() => {
    if (was.current === home) return;
    was.current = home;
    walk.current = still || route.length < 2 ? null : { out: !home, since: performance.now() };
    gl.shadowMap.needsUpdate = true;
    invalidate();
  }, [home, still, route, gl, invalidate]);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const w = walk.current;
    if (!w) {
      g.visible = home;
      g.position.set(person.x, 0, person.z);
      g.rotation.y = deg(person.facing);
      g.scale.setScalar(person.scale);
      return;
    }
    const t = Math.min(1, (performance.now() - w.since) / WALK_MS);
    // From their place (0) to just outside the door (1), easing in and out.
    const eased = t * t * (3 - 2 * t);
    const share = w.out ? eased : 1 - eased;
    const { at, heading } = along(route, share);
    g.visible = true;
    g.position.set(at.x, 0, at.z);
    g.rotation.y = w.out ? heading : heading + Math.PI;
    // Past the door they fade into the distance.
    g.scale.setScalar(person.scale * Math.min(1, (1 - share) / 0.12));
    gl.shadowMap.needsUpdate = true;
    if (t < 1) invalidate();
    else {
      walk.current = null;
      invalidate();
    }
  });
  return (
    <group ref={group} name={person.member} visible={home}>
      <mesh position={[0, 0.62, 0]} castShadow>
        <capsuleGeometry args={[0.17, 0.85, 6, 16]} />
        <meshStandardMaterial color={person.color} roughness={0.8} />
      </mesh>
      <mesh position={[0, 1.37, 0]} castShadow>
        <sphereGeometry args={[0.13, 24, 16]} />
        <meshStandardMaterial color={palette.skin} roughness={0.7} />
      </mesh>
    </group>
  );
}
