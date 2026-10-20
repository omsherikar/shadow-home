'use client';

import { DoubleSide } from 'three';
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
    case 'motion_sensor':
      return <MotionSensor look={look} />;
    case 'smoke_alarm':
      return <SmokeAlarm look={look} />;
    case 'floor_lamp':
      return <FloorLamp look={look} />;
    case 'pendant_light':
      return <Pendant look={look} drop={props.wallHeight - props.placement.y} />;
    case 'bedside_lamp':
      return <BedsideLamp look={look} />;
    case 'desk_lamp':
      return <DeskLamp look={look} />;
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

function MotionSensor({ look }: { look: Look }) {
  return (
    <group>
      <mesh rotation-x={Math.PI / 2} position={[0, 0, 0.005]}>
        <sphereGeometry args={[0.05, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial
          color={palette.ivory}
          emissive={palette.screen}
          emissiveIntensity={look.glow * 1.2}
          roughness={0.3}
        />
      </mesh>
      <Led look={look} position={[0, -0.06, 0.012]} />
    </group>
  );
}

function SmokeAlarm({ look }: { look: Look }) {
  const alarm = look.status === 'alarm';
  return (
    <group>
      <mesh rotation-x={Math.PI / 2} position={[0, 0, 0.016]} castShadow>
        <cylinderGeometry args={[0.085, 0.085, 0.032, 32]} />
        <meshStandardMaterial
          color={palette.ivory}
          emissive={palette.alarm}
          emissiveIntensity={alarm ? 2.5 : 0}
          roughness={0.4}
        />
      </mesh>
      <Led look={look} position={[0.04, 0.02, 0.034]} />
      {alarm ? (
        <pointLight position={[0, 0, 0.4]} color={palette.alarm} intensity={4} distance={4} />
      ) : null}
    </group>
  );
}

/** A warm shade that lights by the lamp's brightness, and the light it throws. */
function Shade(props: {
  look: Look;
  radius: [number, number];
  height: number;
  y: number;
  power: number;
}) {
  const { look } = props;
  return (
    <group position={[0, props.y, 0]}>
      <mesh castShadow>
        <cylinderGeometry args={[props.radius[0], props.radius[1], props.height, 28, 1, true]} />
        <meshStandardMaterial
          color={palette.linen}
          emissive={palette.lamp}
          emissiveIntensity={look.glow * 3.4}
          side={DoubleSide}
          roughness={0.9}
        />
      </mesh>
      {look.glow > 0 ? (
        <pointLight
          position={[0, -props.height * 0.25, 0]}
          color={palette.lamp}
          intensity={props.power * look.glow}
          distance={7}
          decay={2}
        />
      ) : null}
    </group>
  );
}

function FloorLamp({ look }: { look: Look }) {
  return (
    <group>
      <mesh position={[0, 0.015, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.16, 0.03, 24]} />
        <meshStandardMaterial color={palette.graphite} roughness={0.4} metalness={0.4} />
      </mesh>
      <mesh position={[0, 0.74, 0]} castShadow>
        <cylinderGeometry args={[0.012, 0.012, 1.45, 8]} />
        <meshStandardMaterial color={palette.graphite} roughness={0.4} metalness={0.4} />
      </mesh>
      <Shade look={look} radius={[0.15, 0.21]} height={0.3} y={1.52} power={18} />
    </group>
  );
}

function Pendant({ look, drop }: { look: Look; drop: number }) {
  return (
    <group>
      <mesh position={[0, drop / 2, 0]}>
        <cylinderGeometry args={[0.005, 0.005, drop, 6]} />
        <meshStandardMaterial color={palette.graphite} />
      </mesh>
      <Shade look={look} radius={[0.05, 0.24]} height={0.2} y={0} power={16} />
    </group>
  );
}

function BedsideLamp({ look }: { look: Look }) {
  return (
    <group>
      <mesh position={[0, 0.11, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.07, 0.22, 20]} />
        <meshStandardMaterial color={palette.ivory} roughness={0.3} />
      </mesh>
      <Shade look={look} radius={[0.1, 0.14]} height={0.17} y={0.3} power={8} />
    </group>
  );
}

function DeskLamp({ look }: { look: Look }) {
  return (
    <group>
      <mesh position={[0, 0.01, 0]} castShadow>
        <cylinderGeometry args={[0.07, 0.07, 0.02, 20]} />
        <meshStandardMaterial color={palette.graphite} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.2, -0.04]} rotation-x={-0.35} castShadow>
        <boxGeometry args={[0.015, 0.4, 0.015]} />
        <meshStandardMaterial color={palette.graphite} roughness={0.4} />
      </mesh>
      <group position={[0, 0.38, 0.05]} rotation-x={0.5}>
        <Shade look={look} radius={[0.03, 0.08]} height={0.1} y={0} power={7} />
      </group>
    </group>
  );
}
