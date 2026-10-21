'use client';

import { useFrame, useLoader } from '@react-three/fiber';
import { useMemo } from 'react';
import {
  CanvasTexture,
  type Material,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
} from 'three';
import { houseBounds, type WallPiece, wallHeightAt, wallPieces } from './geometry.ts';
import { ghost, ghostly } from './ghost.ts';
import type { Built, HouseLayout, Opening, Room } from './layout.ts';
import { type LiveHome, lookOf } from './looks.ts';
import { palette } from './palette.ts';

const deg = (d: number) => (d * Math.PI) / 180;

/** The house without its furniture and devices: ground, floors, walls, doors and built pieces. */
export function Shell({ layout, home }: { layout: HouseLayout; home: LiveHome | null }) {
  const device = (id: string | undefined) => home?.devices.find((d) => d.id === id);
  return (
    <>
      <Grounds layout={layout} />
      {layout.rooms.map((r) => (
        <Floor key={r.id} room={r} layout={layout} />
      ))}
      <Walls layout={layout} />
      {layout.openings.map((o) => (
        <OpeningFill
          key={`${o.from.x},${o.from.z}`}
          opening={o}
          wallHeight={wallHeightAt(layout, o)}
          open={lookOf(device(o.device)).open}
        />
      ))}
      {layout.built.map((b) => (
        <BuiltPiece
          key={`${b.shape},${b.x},${b.z}`}
          piece={b}
          glow={lookOf(device(b.drivenBy)).glow}
        />
      ))}
    </>
  );
}

/** Lets a JSX material take part in the shadow twin. */
const twin = (m: Material | null) => ghostly(m);

/**
 * The ground: a lawn that fades out into the sky behind it, a soft shadow where the house meets
 * it, a drive to the garage and a path to the front door.
 */
function Grounds({ layout }: { layout: HouseLayout }) {
  const { min, max } = houseBounds(layout);
  const cx = (min.x + max.x) / 2;
  const cz = (min.z + max.z) / 2;
  const fade = useMemo(() => radialFade(), []);
  const shade = useMemo(() => softShadow(), []);
  const garageDoor = layout.openings.find((o) => o.kind === 'garage_door');
  const frontDoor = layout.openings.find((o) => o.kind === 'door' && o.from.z === max.z);
  const reach = max.z + 4.5;
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[cx, 0, cz]} receiveShadow>
        <circleGeometry args={[19, 64]} />
        <meshStandardMaterial
          color={palette.lawn}
          roughness={1}
          alphaMap={fade}
          transparent
          depthWrite={false}
        />
      </mesh>
      {/* Where the house sits on the ground, a soft darkening around its footprint. */}
      <mesh rotation-x={-Math.PI / 2} position={[cx, 0.002, cz]}>
        <planeGeometry args={[max.x - min.x + 4, max.z - min.z + 4]} />
        <meshBasicMaterial
          color="#000000"
          alphaMap={shade}
          transparent
          opacity={0.6}
          depthWrite={false}
        />
      </mesh>
      {garageDoor ? (
        <Slab
          x0={garageDoor.from.x - 0.1}
          x1={garageDoor.to.x + 0.1}
          z0={max.z}
          z1={reach}
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
            z1={reach}
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

/** White in the middle, fading to nothing at the rim: the lawn's edge melting into the haze. */
function radialFade(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  if (g) {
    const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    r.addColorStop(0, '#ffffff');
    r.addColorStop(0.5, '#ffffff');
    r.addColorStop(1, '#000000');
    g.fillStyle = r;
    g.fillRect(0, 0, 256, 256);
  }
  return new CanvasTexture(c);
}

/** A blurred rectangle the shape of the house's footprint, built up in soft steps. */
function softShadow(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#000000';
    g.fillRect(0, 0, 256, 256);
    const steps = 24;
    for (let i = 0; i < steps; i++) {
      const inset = 4 + i * 2.2;
      g.fillStyle = `rgba(255, 255, 255, ${0.06})`;
      g.fillRect(inset, inset, 256 - 2 * inset, 256 - 2 * inset);
    }
  }
  return new CanvasTexture(c);
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
        ref={twin}
        map={map}
        normalMap={normalMap}
        aoMap={arm}
        roughnessMap={arm}
        metalnessMap={arm}
      />
    </mesh>
  );
}

/** The walls: solid in the real house, half see-through in the twin. */
function Walls({ layout }: { layout: HouseLayout }) {
  const pieces = useMemo(() => wallPieces(layout), [layout]);
  const plaster = useMemo(() => {
    const m = new MeshStandardMaterial({
      color: palette.plaster,
      roughness: 0.92,
      transparent: true,
    });
    ghostly(m);
    return m;
  }, []);
  const cut = useMemo(() => {
    const m = new MeshStandardMaterial({ color: palette.cut, roughness: 0.8, transparent: true });
    ghostly(m);
    return m;
  }, []);
  // Always blended, so turning see-through costs no shader rebuild mid-playback.
  useFrame(() => {
    for (const m of [plaster, cut]) m.opacity = 1 - 0.5 * ghost.value;
  });
  return (
    <group>
      {pieces.map((p) => (
        <WallBox
          key={`${p.a.x},${p.a.z},${p.b.x},${p.b.z},${p.bottom}`}
          piece={p}
          thickness={layout.wallThickness}
          plaster={plaster}
          cut={cut}
        />
      ))}
    </group>
  );
}

function WallBox(props: {
  piece: WallPiece;
  thickness: number;
  plaster: MeshStandardMaterial;
  cut: MeshStandardMaterial;
}) {
  const { piece, thickness } = props;
  const alongX = piece.a.z === piece.b.z;
  const start = (alongX ? piece.a.x : piece.a.z) - (piece.joinA ? thickness / 2 : 0);
  const end = (alongX ? piece.b.x : piece.b.z) + (piece.joinB ? thickness / 2 : 0);
  const length = end - start;
  const mid = (start + end) / 2;
  const height = piece.top - piece.bottom;
  const x = alongX ? mid : piece.a.x;
  const z = alongX ? piece.a.z : mid;
  const size: [number, number, number] = alongX
    ? [length, height, thickness]
    : [thickness, height, length];
  return (
    <group>
      <mesh
        position={[x, piece.bottom + height / 2, z]}
        material={props.plaster}
        castShadow
        receiveShadow
      >
        <boxGeometry args={size} />
      </mesh>
      {piece.capped ? (
        // The cut through the wall, drawn dark like a section on a plan.
        <mesh position={[x, piece.top + 0.005, z]} material={props.cut}>
          <boxGeometry args={[size[0] + 0.002, 0.01, size[2] + 0.002]} />
        </mesh>
      ) : null}
    </group>
  );
}

/** What fills a gap in a wall: a door leaf, the garage door, or a window that opens. */
function OpeningFill(props: { opening: Opening; wallHeight: number; open: boolean }) {
  const o = props.opening;
  if (o.kind === 'doorway') return null;
  const alongX = o.from.z === o.to.z;
  const span = alongX ? Math.abs(o.to.x - o.from.x) : Math.abs(o.to.z - o.from.z);
  const cx = (o.from.x + o.to.x) / 2;
  const cz = (o.from.z + o.to.z) / 2;
  const turn = alongX ? 0 : Math.PI / 2;
  if (o.kind === 'window') {
    const height = o.top - o.bottom;
    // Hinged at the top; an open window swings out.
    return (
      <group position={[cx, o.top, cz]} rotation-y={turn}>
        <group rotation-x={props.open ? deg(-24) : 0}>
          <mesh position={[0, -height / 2, 0]}>
            <boxGeometry args={[span - 0.04, height - 0.04, 0.02]} />
            <meshStandardMaterial
              color={palette.glass}
              transparent
              opacity={0.35}
              roughness={0.05}
              metalness={0.1}
            />
          </mesh>
          <Frame width={span} height={height} />
        </group>
      </group>
    );
  }
  const height = Math.min(o.top, props.wallHeight);
  const color = o.kind === 'garage_door' ? palette.garageDoor : palette.frontDoor;
  return (
    <mesh position={[cx, height / 2, cz]} rotation-y={turn} castShadow receiveShadow>
      <boxGeometry args={[span - 0.03, height, 0.05]} />
      <meshStandardMaterial ref={twin} color={color} roughness={0.6} />
    </mesh>
  );
}

function Frame({ width, height }: { width: number; height: number }) {
  const bar = 0.04;
  const bars: [number, number, number, number][] = [
    [0, -bar / 2, width, bar],
    [0, -height + bar / 2, width, bar],
    [-width / 2 + bar / 2, -height / 2, bar, height],
    [width / 2 - bar / 2, -height / 2, bar, height],
  ];
  return (
    <>
      {bars.map(([x, y, w, h]) => (
        <mesh key={`${x},${y}`} position={[x, y, 0]} castShadow>
          <boxGeometry args={[w, h, 0.05]} />
          <meshStandardMaterial ref={twin} color={palette.ivory} roughness={0.5} />
        </mesh>
      ))}
    </>
  );
}

/** Counters, beds, rugs, the garage heater and its light, from simple shapes in matching materials. */
function BuiltPiece({ piece: b, glow }: { piece: Built; glow: number }) {
  return (
    <group position={[b.x, b.y, b.z]} rotation-y={deg(b.facing)}>
      {b.shape === 'counter' ? <Counter b={b} /> : null}
      {b.shape === 'bed' ? <Bed b={b} /> : null}
      {b.shape === 'rug' ? (
        <mesh position={[0, b.height / 2, 0]} receiveShadow>
          <boxGeometry args={[b.width, b.height, b.depth]} />
          <meshStandardMaterial
            ref={twin}
            color={b.room === 'living_room' ? palette.rugLiving : palette.rugBedroom}
            roughness={1}
          />
        </mesh>
      ) : null}
      {b.shape === 'wall_heater' ? (
        <group position={[0, b.height / 2, 0]}>
          <mesh castShadow>
            <boxGeometry args={[b.width, b.height, b.depth]} />
            <meshStandardMaterial color={palette.graphite} roughness={0.5} metalness={0.3} />
          </mesh>
          <mesh position={[0, 0, b.depth / 2 + 0.002]}>
            <planeGeometry args={[b.width * 0.85, b.height * 0.6]} />
            <meshStandardMaterial
              color={palette.graphite}
              emissive={palette.heat}
              emissiveIntensity={glow >= 1 ? 2.6 : 0}
            />
          </mesh>
        </group>
      ) : null}
      {b.shape === 'tube_light' ? <TubeLight b={b} /> : null}
    </group>
  );
}

/** The garage's tube light: scenery, always on, so the garage isn't a black hole at dusk. */
function TubeLight({ b }: { b: Built }) {
  return (
    <group>
      <mesh castShadow>
        <boxGeometry args={[b.width, b.height, b.depth]} />
        <meshStandardMaterial ref={twin} color={palette.ivory} roughness={0.5} />
      </mesh>
      <mesh position={[0, -b.height / 2, b.depth / 4]} rotation-z={Math.PI / 2}>
        <cylinderGeometry args={[0.025, 0.025, b.width - 0.1, 12]} />
        <meshStandardMaterial color="#fff6e8" emissive="#fff1dc" emissiveIntensity={3.2} />
      </mesh>
      <pointLight
        position={[0, -0.25, 1.2]}
        color="#ffe9cc"
        intensity={16}
        distance={9}
        decay={2}
      />
    </group>
  );
}

function Counter({ b }: { b: Built }) {
  return (
    <>
      <mesh position={[0, (b.height - 0.04) / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[b.width, b.height - 0.04, b.depth]} />
        <meshStandardMaterial ref={twin} color={palette.counterFront} roughness={0.7} />
      </mesh>
      <mesh position={[0, b.height - 0.02, 0.01]} castShadow receiveShadow>
        <boxGeometry args={[b.width + 0.02, 0.04, b.depth + 0.02]} />
        <meshStandardMaterial ref={twin} color={palette.counterTop} roughness={0.35} />
      </mesh>
    </>
  );
}

/**
 * A bed whose foot faces the way it faces: a walnut frame, a padded headboard, a white sheet, a
 * duvet turned down at the top and a pillow for each sleeper.
 */
function Bed({ b }: { b: Built }) {
  const sam = b.room === 'bedroom_sam';
  const duvet = sam ? palette.duvetSam : palette.duvetMain;
  const head = -b.depth / 2;
  const pillows = sam ? [0] : [-b.width / 4, b.width / 4];
  const pillowWidth = sam ? 0.55 : b.width / 2 - 0.12;
  return (
    <>
      <mesh position={[0, 0.13, 0]} castShadow receiveShadow>
        <boxGeometry args={[b.width + 0.06, 0.26, b.depth + 0.04]} />
        <meshStandardMaterial ref={twin} color={palette.walnut} roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.37, 0.02]} castShadow receiveShadow>
        <boxGeometry args={[b.width - 0.02, 0.22, b.depth - 0.06]} />
        <meshStandardMaterial ref={twin} color={palette.sheet} roughness={0.95} />
      </mesh>
      {/* The duvet covers all but the head, and turns down in a white band. */}
      <mesh position={[0, 0.5, 0.33]} castShadow receiveShadow>
        <boxGeometry args={[b.width + 0.02, 0.07, b.depth - 0.62]} />
        <meshStandardMaterial ref={twin} color={duvet} roughness={1} />
      </mesh>
      <mesh position={[0, 0.54, head + 0.62]} castShadow>
        <boxGeometry args={[b.width + 0.02, 0.05, 0.18]} />
        <meshStandardMaterial ref={twin} color={palette.sheet} roughness={0.95} />
      </mesh>
      {pillows.map((x) => (
        <mesh key={x} position={[x, 0.53, head + 0.28]} castShadow>
          <boxGeometry args={[pillowWidth, 0.12, 0.34]} />
          <meshStandardMaterial ref={twin} color={palette.sheet} roughness={1} />
        </mesh>
      ))}
      <mesh position={[0, 0.6, head + 0.03]} castShadow receiveShadow>
        <boxGeometry args={[b.width + 0.1, 1.2, 0.07]} />
        <meshStandardMaterial ref={twin} color={palette.walnut} roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.72, head + 0.075]} castShadow>
        <boxGeometry args={[b.width - 0.1, 0.62, 0.05]} />
        <meshStandardMaterial ref={twin} color={palette.headboard} roughness={1} />
      </mesh>
    </>
  );
}
