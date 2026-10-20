'use client';

import type { DevicePlacement, DeviceShape, HouseLayout } from './layout.ts';
import { type LiveHome, type Look, lookOf } from './looks.ts';
import { palette } from './palette.ts';

const deg = (d: number) => (d * Math.PI) / 180;

/**
 * Every smart device in its place, drawn as a simple clean object facing +z before its turn:
 * lights glow by brightness, plugs light what they power, locks and windows show open or shut,
 * and each sensor has a status light (amber when its reading can't be trusted).
 */
export function Devices({ layout, home }: { layout: HouseLayout; home: LiveHome | null }) {
  return (
    <>
      {layout.devices.map((p) => (
        <group key={p.device} name={p.device} position={[p.x, p.y, p.z]} rotation-y={deg(p.facing)}>
          <Shape
            shape={p.shape}
            look={lookOf(home?.devices.find((d) => d.id === p.device))}
            placement={p}
            wallHeight={layout.wallHeight}
          />
        </group>
      ))}
    </>
  );
}

function Shape(props: {
  shape: DeviceShape;
  look: Look;
  placement: DevicePlacement;
  wallHeight: number;
}) {
  const { look } = props;
  switch (props.shape) {
    case 'thermostat':
      return <Thermostat look={look} />;
  }
}

/** A round wall thermostat whose ring glows warm while it heats. */
function Thermostat({ look }: { look: Look }) {
  return (
    <group>
      <mesh rotation-x={Math.PI / 2} position={[0, 0, 0.016]} castShadow>
        <cylinderGeometry args={[0.08, 0.08, 0.032, 32]} />
        <meshStandardMaterial color={palette.ivory} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0, 0.034]}>
        <torusGeometry args={[0.06, 0.008, 8, 40]} />
        <meshStandardMaterial
          color={palette.graphite}
          emissive={look.glow >= 1 ? palette.heat : palette.lamp}
          emissiveIntensity={look.glow >= 1 ? 4 : look.glow * 2}
        />
      </mesh>
    </group>
  );
}
