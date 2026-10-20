'use client';

import type { DevicePlacement, DeviceShape, HouseLayout } from './layout.ts';
import { type LiveHome, type Look, lookOf } from './looks.ts';
import { palette, statusColor } from './palette.ts';

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
    case 'aquarium':
      return <Aquarium look={look} />;
    case 'tv':
      return <Tv look={look} />;
    case 'coffee_maker':
      return <CoffeeMaker look={look} />;
    case 'dishwasher':
      return <Dishwasher look={look} />;
    case 'latch_sensor':
    case 'contact_sensor':
      return <ContactSensor look={look} />;
    case 'door_lock':
      return <DoorLock look={look} />;
  }
}

/** A small status light. */
function Led({ look, position }: { look: Look; position: [number, number, number] }) {
  const lit = look.status !== 'off';
  return (
    <mesh position={position}>
      <sphereGeometry args={[0.014, 12, 8]} />
      <meshStandardMaterial
        color={statusColor(look.status)}
        emissive={statusColor(look.status)}
        emissiveIntensity={lit ? 4 : 0}
      />
    </mesh>
  );
}

function Ivory(props: { size: [number, number, number]; position: [number, number, number] }) {
  return (
    <mesh position={props.position} castShadow receiveShadow>
      <boxGeometry args={props.size} />
      <meshStandardMaterial color={palette.ivory} roughness={0.45} />
    </mesh>
  );
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

function Aquarium({ look }: { look: Look }) {
  const on = look.glow > 0;
  return (
    <group position={[0, 0.17, 0]}>
      <mesh>
        <boxGeometry args={[0.6, 0.34, 0.3]} />
        <meshStandardMaterial color={palette.glass} transparent opacity={0.25} roughness={0.05} />
      </mesh>
      <mesh position={[0, -0.02, 0]}>
        <boxGeometry args={[0.57, 0.27, 0.27]} />
        <meshStandardMaterial
          color={palette.water}
          transparent
          opacity={0.7}
          emissive={palette.water}
          emissiveIntensity={on ? 2 : 0.05}
        />
      </mesh>
      <mesh position={[0, 0.18, 0]} castShadow>
        <boxGeometry args={[0.62, 0.025, 0.32]} />
        <meshStandardMaterial color={palette.graphite} roughness={0.5} />
      </mesh>
      {on ? <pointLight color={palette.water} intensity={2} distance={2.2} /> : null}
    </group>
  );
}

function Tv({ look }: { look: Look }) {
  const on = look.glow > 0;
  return (
    <group>
      <mesh position={[0, 0.03, 0]} castShadow>
        <boxGeometry args={[0.36, 0.03, 0.18]} />
        <meshStandardMaterial color={palette.graphite} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.42, 0]} castShadow>
        <boxGeometry args={[1.15, 0.66, 0.04]} />
        <meshStandardMaterial color={palette.graphite} roughness={0.3} metalness={0.2} />
      </mesh>
      <mesh position={[0, 0.42, 0.021]}>
        <planeGeometry args={[1.1, 0.61]} />
        <meshStandardMaterial
          color={on ? palette.screen : '#0d0f12'}
          emissive={palette.screen}
          emissiveIntensity={on ? 2.4 : 0}
          roughness={0.15}
        />
      </mesh>
      {on ? (
        <pointLight position={[0, 0.42, 0.4]} color={palette.screen} intensity={3} distance={3} />
      ) : null}
    </group>
  );
}

function CoffeeMaker({ look }: { look: Look }) {
  const on = look.glow > 0;
  return (
    <group>
      <mesh position={[0, 0.16, -0.02]} castShadow>
        <boxGeometry args={[0.2, 0.32, 0.2]} />
        <meshStandardMaterial color={palette.graphite} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.07, 0.07]} castShadow>
        <cylinderGeometry args={[0.06, 0.07, 0.13, 20]} />
        <meshStandardMaterial
          color={on ? '#5a3a24' : palette.glass}
          transparent
          opacity={0.75}
          roughness={0.1}
        />
      </mesh>
      <mesh position={[0.06, 0.25, 0.081]}>
        <sphereGeometry args={[0.016, 12, 8]} />
        <meshStandardMaterial
          color={on ? palette.heat : palette.graphite}
          emissive={palette.heat}
          emissiveIntensity={on ? 4 : 0}
        />
      </mesh>
      {on ? (
        <pointLight position={[0, 0.3, 0.2]} color={palette.heat} intensity={1} distance={1.5} />
      ) : null}
    </group>
  );
}

function Dishwasher({ look }: { look: Look }) {
  const on = look.glow > 0;
  return (
    <group>
      <mesh position={[0, 0.43, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.59, 0.86, 0.58]} />
        <meshStandardMaterial color={palette.steel} roughness={0.35} metalness={0.6} />
      </mesh>
      <mesh position={[0, 0.8, 0.292]}>
        <boxGeometry args={[0.55, 0.07, 0.01]} />
        <meshStandardMaterial
          color={palette.graphite}
          emissive={palette.screen}
          emissiveIntensity={on ? 1.8 : 0}
        />
      </mesh>
    </group>
  );
}

/** Two small blocks, apart when the door or window they watch is open. */
function ContactSensor({ look }: { look: Look }) {
  const gap = look.open ? 0.07 : 0.008;
  return (
    <group>
      <Ivory size={[0.06, 0.03, 0.022]} position={[-0.03 - gap / 2, 0, 0.011]} />
      <Ivory size={[0.03, 0.03, 0.022]} position={[0.015 + gap / 2, 0, 0.011]} />
      <Led look={look} position={[-0.03 - gap / 2, 0, 0.026]} />
    </group>
  );
}

/** A deadbolt plate whose thumb turn stands upright when locked and lies flat when not. */
function DoorLock({ look }: { look: Look }) {
  return (
    <group>
      <mesh position={[0, 0, 0.012]} castShadow>
        <boxGeometry args={[0.075, 0.16, 0.024]} />
        <meshStandardMaterial color={palette.graphite} roughness={0.35} metalness={0.5} />
      </mesh>
      <mesh position={[0, 0.02, 0.032]} rotation-z={look.open ? Math.PI / 2 : 0}>
        <boxGeometry args={[0.018, 0.06, 0.018]} />
        <meshStandardMaterial color={palette.steel} roughness={0.3} metalness={0.7} />
      </mesh>
      <Led look={look} position={[0, -0.055, 0.026]} />
    </group>
  );
}
