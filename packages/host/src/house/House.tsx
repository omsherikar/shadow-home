'use client';

import { Canvas, useThree } from '@react-three/fiber';
import { Suspense, useLayoutEffect } from 'react';
import { type PerspectiveCamera, Vector3 } from 'three';
import { frame, groundBounds } from './geometry.ts';
import { houseLayout as layout } from './layout.ts';
import type { LiveHome } from './looks.ts';
import { Shell } from './Shell.tsx';

/** A room's name where it shows on screen, in CSS pixels from the canvas's top left. */
export interface ScreenLabel {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface HouseProps {
  /** The live home from get_home_state; null until it arrives. */
  home: LiveHome | null;
  /** The browser took the WebGL context away. Anything that throws is the caller's to catch. */
  onFail(): void;
  /** Where each room's name lands on screen, for the overlay to draw. */
  onLabels(labels: ScreenLabel[]): void;
  /** Moves the house up the picture (positive) or down, as a share of its half-height. */
  shift?: number;
}

// From the front left and above: the dollhouse view.
const VIEW = new Vector3(-0.37, 0.73, 0.57);
const FOV = 30;

/**
 * The demo home in 3D, roof off, showing the live state. It renders only when something changes
 * (`frameloop="demand"`), so it costs nothing while the house is still. An error anywhere in the
 * scene (a model that won't load, say) is rethrown here by React Three Fiber, for the caller's
 * error boundary.
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

function Scene({ home, onLabels, shift = 0 }: HouseProps) {
  return (
    <>
      <CameraRig onLabels={onLabels} shift={shift} />
      <Shell layout={layout} home={home} />
    </>
  );
}

/** Frames the house for the canvas's size, and reports where each room's name falls. */
function CameraRig({ onLabels, shift }: { onLabels: HouseProps['onLabels']; shift: number }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    if (width === 0 || height === 0) return;
    const f = frame(groundBounds(layout), VIEW, FOV, width / height, 0.04, shift);
    camera.aspect = width / height;
    camera.position.copy(f.position);
    camera.lookAt(f.target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    onLabels(
      layout.rooms.map((r) => {
        const p = new Vector3(r.x + r.width / 2, 0.2, r.z + r.depth / 2).project(camera);
        return { id: r.id, name: r.name, x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height };
      }),
    );
    invalidate();
  }, [camera, width, height, shift, onLabels, invalidate]);
  return null;
}
