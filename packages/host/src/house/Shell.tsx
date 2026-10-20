'use client';

import { useLoader } from '@react-three/fiber';
import { useMemo } from 'react';
import { RepeatWrapping, SRGBColorSpace, TextureLoader } from 'three';
import { groundBounds, houseBounds } from './geometry.ts';
import type { HouseLayout, Room } from './layout.ts';
import { palette } from './palette.ts';

/** The house without its furniture and devices: ground, floors, walls, doors and built pieces. */
export function Shell({ layout }: { layout: HouseLayout }) {
  return (
    <>
      <Grounds layout={layout} />
      {layout.rooms.map((r) => (
        <Floor key={r.id} room={r} layout={layout} />
      ))}
    </>
  );
}

/** A diorama plinth: lawn on top, soil at the sides, a drive to the garage and a path to the door. */
function Grounds({ layout }: { layout: HouseLayout }) {
  const { max } = houseBounds(layout);
  const ground = groundBounds(layout);
  const x0 = ground.min.x;
  const x1 = ground.max.x;
  const z0 = ground.min.z;
  const z1 = ground.max.z;
  const garageDoor = layout.openings.find((o) => o.kind === 'garage_door');
  const frontDoor = layout.openings.find((o) => o.kind === 'door' && o.from.z === max.z);
  return (
    <group>
      <mesh position={[(x0 + x1) / 2, -0.18, (z0 + z1) / 2]} receiveShadow>
        <boxGeometry args={[x1 - x0, -ground.min.y, z1 - z0]} />
        <meshStandardMaterial color={palette.soil} roughness={1} />
      </mesh>
      <Slab x0={x0} x1={x1} z0={z0} z1={z1} y={0.001} color={palette.lawn} />
      {garageDoor ? (
        <Slab
          x0={garageDoor.from.x - 0.1}
          x1={garageDoor.to.x + 0.1}
          z0={max.z}
          z1={z1}
          y={0.004}
          color={palette.paving}
        />
      ) : null}
      {frontDoor ? (
        <>
          <Slab
            x0={frontDoor.from.x + 0.05}
            x1={frontDoor.to.x - 0.05}
            z0={max.z}
            z1={z1}
            y={0.004}
            color={palette.path}
          />
          <mesh
            position={[(frontDoor.from.x + frontDoor.to.x) / 2, 0.04, max.z + 0.4]}
            receiveShadow
            castShadow
          >
            <boxGeometry args={[frontDoor.to.x - frontDoor.from.x + 0.6, 0.08, 0.8]} />
            <meshStandardMaterial color={palette.path} roughness={0.9} />
          </mesh>
        </>
      ) : null}
    </group>
  );
}

function Slab(p: { x0: number; x1: number; z0: number; z1: number; y: number; color: string }) {
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position={[(p.x0 + p.x1) / 2, p.y, (p.z0 + p.z1) / 2]}
      receiveShadow
    >
      <planeGeometry args={[p.x1 - p.x0, p.z1 - p.z0]} />
      <meshStandardMaterial color={p.color} roughness={0.95} />
    </mesh>
  );
}

/** A room's floor, its texture repeated at the material's real size. */
function Floor({ room, layout }: { room: Room; layout: HouseLayout }) {
  const surface = layout.floors[room.floor];
  const textures = useLoader(TextureLoader, [surface.color, surface.normal, surface.arm]);
  const [map, normalMap, arm] = useMemo(
    () =>
      textures.map((t, i) => {
        const c = t.clone();
        c.wrapS = RepeatWrapping;
        c.wrapT = RepeatWrapping;
        c.repeat.set(room.width / surface.tile, room.depth / surface.tile);
        c.anisotropy = 8;
        if (i === 0) c.colorSpace = SRGBColorSpace;
        c.needsUpdate = true;
        return c;
      }),
    [textures, room.width, room.depth, surface.tile],
  );
  return (
    <mesh
      rotation-x={-Math.PI / 2}
      position={[room.x + room.width / 2, 0.003, room.z + room.depth / 2]}
      receiveShadow
    >
      <planeGeometry args={[room.width, room.depth]} />
      <meshStandardMaterial
        map={map}
        normalMap={normalMap}
        aoMap={arm}
        roughnessMap={arm}
        metalnessMap={arm}
      />
    </mesh>
  );
}
