'use client';

import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, N8AO, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { EquirectangularReflectionMapping, Object3D, type PerspectiveCamera, Vector3 } from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Devices } from './Devices.tsx';
import { Furniture, People } from './Furniture.tsx';
import { type Band, bandBetween, frame, groundBounds, houseBounds, overlaps } from './geometry.ts';
import { ghost } from './ghost.ts';
import { houseLayout as layout } from './layout.ts';
import { type Daylight, daylight, type LiveDevice } from './looks.ts';
import { temperatureColor } from './playback.ts';
import { Shell } from './Shell.tsx';

/** A point in the house that something on the page is pinned to: a label, a status dot, a card. */
export interface Anchor {
  id: string;
  at: [number, number, number];
}

/** What the house shows: the live home, or a moment of a plan playing in the shadow twin. */
export interface HouseView {
  devices: LiveDevice[] | null;
  presence: Record<string, 'home' | 'away'> | undefined;
  /** The home time the light outside follows. */
  time: string;
  /** Each zone's temperature, to tint its rooms; null for the live house. */
  zonesC: Record<string, number> | null;
  /** 0 is the real house, 1 the shadow twin. */
  shadow: number;
  /** The room to move in on, or null for the whole house. */
  focus: string | null;
}

export interface HouseProps {
  view: HouseView;
  /** Beside the device (a tall, narrow panel) or alone (the whole page). */
  mode: 'split' | 'house';
  anchors: Anchor[];
  /** The page element pinned to an anchor, if it's there. */
  pinned(id: string): HTMLElement | null | undefined;
  /** Pixels covered along the top and bottom of the panel: the house is framed between them. */
  inset: { top: number; bottom: number };
  /** Skip camera moves and fades. */
  still: boolean;
  /** The browser took the WebGL context away. Anything that throws is the caller's to catch. */
  onFail(): void;
}

const FOV = 30;
// Alone, from the front left and above: the dollhouse view. Beside the device, from the west, so
// the house's long side runs up the narrow panel and fills it.
const VIEWS = {
  house: new Vector3(-0.37, 0.73, 0.57),
  split: direction(82, 56),
} as const;

function direction(azimuthFromSouth: number, elevation: number): Vector3 {
  const a = (azimuthFromSouth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  return new Vector3(-Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}

/**
 * The demo home in 3D, roof off. It renders only when something changes (`frameloop="demand"`):
 * a new view from the caller, the camera gliding, the twin fading. An error anywhere in the scene
 * (a model that won't load, say) is rethrown here by React Three Fiber, for the caller's error
 * boundary.
 */
export default function House(props: HouseProps) {
  return (
    <Canvas
      className="house-canvas"
      frameloop="demand"
      shadows="percentage"
      flat
      dpr={[1, 2]}
      camera={{ fov: FOV, near: 0.5, far: 300, position: [0, 30, 30] }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener('webglcontextlost', props.onFail, { once: true });
      }}
    >
      <Suspense fallback={null}>
        <Scene {...props} />
      </Suspense>
    </Canvas>
  );
}

function Scene({ view, mode, anchors, pinned, still, inset }: HouseProps) {
  const light = daylight(view.time);
  return (
    <>
      <Environment intensity={light.sky} />
      <KeyLight light={light} />
      <CameraRig
        mode={mode}
        focus={view.focus}
        anchors={anchors}
        pinned={pinned}
        still={still}
        inset={inset}
      />
      <TwinFade shadow={view.shadow} still={still} />
      <Shell layout={layout} devices={view.devices} />
      <RoomTints zonesC={view.zonesC} />
      <Furniture layout={layout} />
      <Devices layout={layout} devices={view.devices} />
      <People layout={layout} presence={view.presence} />
      <Finish />
    </>
  );
}

/**
 * The finish: ambient occlusion where things meet, a glow on whatever is lit, and filmic tone
 * mapping. Nothing here needs a worker or WebAssembly.
 */
const Finish = memo(function Finish() {
  return (
    <EffectComposer multisampling={4}>
      <N8AO halfRes aoRadius={0.9} distanceFalloff={0.7} intensity={3.6} color="#1b130d" />
      <Bloom mipmapBlur luminanceThreshold={1.6} luminanceSmoothing={0.2} intensity={0.9} />
      <ToneMapping mode={ToneMappingMode.AGX} />
    </EffectComposer>
  );
});

/** The sky's light on everything, from a local HDR file (nothing is fetched elsewhere). */
function Environment({ intensity }: { intensity: number }) {
  const hdr = useLoader(HDRLoader, layout.environment);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    hdr.mapping = EquirectangularReflectionMapping;
    scene.environment = hdr;
    return () => {
      scene.environment = null;
    };
  }, [hdr, scene]);
  useLayoutEffect(() => {
    scene.environmentIntensity = intensity;
    invalidate();
  }, [scene, intensity, invalidate]);
  return null;
}

// The middle of the house, which the key light aims at.
const CENTRE = (() => {
  const { min, max } = houseBounds(layout);
  return min.clone().add(max).multiplyScalar(0.5);
})();

/** The sun by day, the moon by night: the one light that casts shadows. */
function KeyLight({ light }: { light: Daylight }) {
  const target = useMemo(() => {
    const o = new Object3D();
    o.position.copy(CENTRE);
    return o;
  }, []);
  const [dx, dy, dz] = light.direction;
  return (
    <>
      <primitive object={target} />
      <directionalLight
        target={target}
        position={[CENTRE.x + dx * 40, CENTRE.y + dy * 40, CENTRE.z + dz * 40]}
        color={light.keyColor}
        intensity={light.key}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-13}
        shadow-camera-right={13}
        shadow-camera-top={13}
        shadow-camera-bottom={-13}
        shadow-camera-near={5}
        shadow-camera-far={90}
        shadow-bias={-0.0005}
        shadow-normalBias={0.03}
        shadow-radius={3}
      />
      <hemisphereLight args={['#b8c4f0', '#2a2018', 0.35 * light.sky]} />
    </>
  );
}

const ROOMS = new Map(layout.rooms.map((r) => [r.id, r]));

// Alone, the house sits a little above the caption that floats along the bottom.
const ALONE: Band = { center: 0.08, half: 0.92 };

/**
 * Frames the whole house for the canvas's size, or one room when there's something to look at,
 * gliding between them, in the part of the panel nothing covers; and keeps everything pinned to
 * the house where it shows on screen, hiding what would fall outside that part rather than cut it.
 */
function CameraRig(props: {
  mode: HouseProps['mode'];
  focus: string | null;
  anchors: Anchor[];
  pinned: HouseProps['pinned'];
  still: boolean;
  inset: HouseProps['inset'];
}) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);
  const room = props.focus ? ROOMS.get(props.focus) : undefined;
  const { top, bottom } = props.inset;
  const goal = useMemo(() => {
    const aspect = width / Math.max(1, height);
    const view = VIEWS[props.mode];
    const band = props.mode === 'split' ? bandBetween(top, bottom, height) : undefined;
    if (room) {
      const box = {
        min: new Vector3(room.x, 0, room.z),
        max: new Vector3(room.x + room.width, layout.wallHeight, room.z + room.depth),
      };
      return frame(box, view, FOV, aspect, 0.18, band);
    }
    const whole = props.mode === 'split' ? houseBounds(layout) : groundBounds(layout);
    return frame(whole, view, FOV, aspect, 0.04, band ?? ALONE);
  }, [width, height, props.mode, room, top, bottom]);
  const at = useRef<{ position: Vector3; target: Vector3 } | null>(null);
  const tmp = useMemo(() => new Vector3(), []);

  useLayoutEffect(() => {
    if (width === 0 || height === 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (!at.current || props.still) {
      at.current = { position: goal.position.clone(), target: goal.target.clone() };
    }
    invalidate();
  }, [camera, width, height, goal, props.still, invalidate]);

  useFrame((_, delta) => {
    const now = at.current;
    if (!now) return;
    const k = props.still ? 1 : 1 - Math.exp(-Math.min(delta, 1 / 30) * 2.6);
    now.position.lerp(goal.position, k);
    now.target.lerp(goal.target, k);
    camera.position.copy(now.position);
    camera.lookAt(now.target);
    camera.updateMatrixWorld();
    for (const a of props.anchors) {
      const el = props.pinned(a.id);
      if (!el) continue;
      tmp.set(a.at[0], a.at[1], a.at[2]).project(camera);
      const x = ((tmp.x + 1) / 2) * width;
      const y = ((1 - tmp.y) / 2) * height;
      // A room's name is centred on its point; a dot's name runs off to one side of it.
      const room = a.id.startsWith('room:');
      const side = room ? 64 : 14;
      const inside =
        tmp.z < 1 && x >= side && x <= width - side && y >= top + 14 && y <= height - bottom - 14;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      el.style.visibility = inside ? 'visible' : 'hidden';
      // Near the right edge a dot's name goes on its left, so it isn't cut off.
      if (!room) el.dataset.side = x > width - 120 ? 'left' : 'right';
    }
    hideCovered(props.anchors.map((a) => props.pinned(a.id)));
    if (now.position.distanceToSquared(goal.position) > 1e-4) invalidate();
  });
  return null;
}

/**
 * Hides each label or dot that a card pinned to the house covers, even in part, so nothing shows
 * half hidden. A card marks itself with `data-covers`.
 */
function hideCovered(pins: (HTMLElement | null | undefined)[]) {
  const shown = pins.filter((el): el is HTMLElement => !!el && el.style.visibility === 'visible');
  const covers = shown.flatMap((el) => {
    const card = el.querySelector('[data-covers]');
    return card ? [card.getBoundingClientRect()] : [];
  });
  if (covers.length === 0) return;
  for (const el of shown) {
    if (el.querySelector('[data-covers]')) continue;
    const under = Array.from(el.children).some((part) => {
      const box = part.getBoundingClientRect();
      return covers.some((c) => overlaps(box, c));
    });
    if (under) el.style.visibility = 'hidden';
  }
}

/** Fades the house into the shadow twin and back. */
function TwinFade({ shadow, still }: { shadow: number; still: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  const target = useRef(shadow);
  useEffect(() => {
    target.current = shadow;
    invalidate();
  }, [shadow, invalidate]);
  useEffect(
    () => () => {
      ghost.value = 0;
    },
    [],
  );
  useFrame((_, delta) => {
    const goal = target.current;
    const k = still ? 1 : 1 - Math.exp(-Math.min(delta, 1 / 30) * 3);
    ghost.value += (goal - ghost.value) * k;
    if (Math.abs(goal - ghost.value) > 0.002) invalidate();
    else ghost.value = goal;
  });
  return null;
}

/** While a plan plays, each room's floor washes warm or icy with its zone's temperature. */
function RoomTints({ zonesC }: { zonesC: Record<string, number> | null }) {
  return (
    <>
      {layout.rooms.map((r) => {
        const c = zonesC?.[r.zone];
        return (
          <mesh
            key={r.id}
            rotation-x={-Math.PI / 2}
            position={[r.x + r.width / 2, 0.02, r.z + r.depth / 2]}
          >
            <planeGeometry args={[r.width - 0.1, r.depth - 0.1]} />
            {/* Always drawn, clear when there's nothing to show, so it costs no rebuild later. */}
            <meshBasicMaterial
              color={temperatureColor(c ?? 15)}
              transparent
              opacity={c === undefined ? 0 : 0.34}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        );
      })}
    </>
  );
}
