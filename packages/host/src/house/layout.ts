import { z } from 'zod';

/**
 * The demo home's floor plan for the 3D house, made by hand for fixtures/demo-home.json.
 *
 * Units are metres. The plan lies on the ground: x runs west to east, z runs north to south (the
 * front of the house, where the camera stands, is +z), and y is height above the floor. A facing
 * is a turn about the vertical in degrees, counterclockwise seen from above: 0 faces south (+z),
 * 90 east, 180 north, -90 west.
 *
 *   x: 0          5.5               11              15.5
 *   z=0 ┌──────────┬─────────────────┬───────────────┐
 *       │          │ Kitchen         │ Main bedroom  │
 *       │          ├──────┐    ┌─────┤               │
 *       │  Garage  │ Living room     ├───────────────┤
 *       │          │                 │ Sam's room    │
 *   z=9 └══════════┴──────[door]─────┴───────────────┘
 *        garage door
 *
 * The house is shown as a cutaway: the back walls (north and east) stand full height and every
 * other wall is cut at `cutHeight`, so each room can be seen from above the front.
 */

const metres = z.number().finite();
const facing = z.number().min(-180).max(180);

/** Files the host serves from public/house/. */
const assetPath = z.string().regex(/^\/house\/[a-z0-9_/]+\.(glb|webp|hdr)$/);

const room = z.object({
  /** A room ID from the fixture, and its name there. */
  id: z.string(),
  name: z.string(),
  zone: z.enum(['house', 'garage']),
  /** North-west corner and size of the floor. */
  x: metres,
  z: metres,
  width: metres.positive(),
  depth: metres.positive(),
  floor: z.enum(['wood', 'tile', 'concrete']),
});

/** A gap in a wall, given by its two ends on the wall's line and its height above the floor. */
const opening = z.object({
  kind: z.enum(['door', 'doorway', 'garage_door', 'window']),
  from: z.object({ x: metres, z: metres }),
  to: z.object({ x: metres, z: metres }),
  bottom: metres.nonnegative(),
  top: metres.positive(),
  /** The device that shows on it: a door's lock, a window's contact sensor. */
  device: z.string().optional(),
});

/** How a device is drawn: simple clean objects that light up or move as their state changes. */
export const deviceShapes = [
  'thermostat',
  'aquarium',
  'tv',
  'coffee_maker',
  'dishwasher',
  'latch_sensor',
  'door_lock',
  'contact_sensor',
  'motion_sensor',
  'smoke_alarm',
  'floor_lamp',
  'pendant_light',
  'bedside_lamp',
  'desk_lamp',
  'porch_light',
  'space_heater',
  'chest_freezer',
] as const;
export type DeviceShape = (typeof deviceShapes)[number];

const devicePlacement = z.object({
  /** A device ID from the fixture. */
  device: z.string(),
  shape: z.enum(deviceShapes),
  x: metres,
  /** Height of the device's base above the floor. */
  y: metres,
  z: metres,
  facing,
});

/** A downloaded model (see public/house/CREDITS.md), placed with its base on `y`. */
const prop = z.object({
  model: assetPath,
  room: z.string(),
  x: metres,
  y: metres.default(0),
  z: metres,
  facing: facing.default(0),
  /** Some sources are authored at another scale. */
  scale: z.number().positive().default(1),
});

/** Pieces built from simple shapes where no CC0 model fits. */
const built = z.object({
  shape: z.enum(['counter', 'bed', 'rug', 'wall_heater']),
  room: z.string(),
  x: metres,
  y: metres.default(0),
  z: metres,
  width: metres.positive(),
  depth: metres.positive(),
  height: metres.positive(),
  facing: facing.default(0),
  /** The device whose state drives it: the garage heater glows while its thermostat heats. */
  drivenBy: z.string().optional(),
});

/** Where each person stands when home. Away, they aren't drawn. */
const person = z.object({
  member: z.string(),
  x: metres,
  z: metres,
  facing,
  color: z.string().regex(/^#[0-9a-f]{6}$/),
  /** Sam is a child. */
  scale: z.number().positive().default(1),
});

const surface = z.object({ color: assetPath, normal: assetPath, arm: assetPath, tile: metres });

export const houseLayoutSchema = z.object({
  name: z.string(),
  wallHeight: metres.positive(),
  cutHeight: metres.positive(),
  wallThickness: metres.positive(),
  rooms: z.array(room),
  openings: z.array(opening),
  devices: z.array(devicePlacement),
  props: z.array(prop),
  built: z.array(built),
  people: z.array(person),
  floors: z.object({ wood: surface, tile: surface, concrete: surface }),
  environment: assetPath,
});

export type HouseLayout = z.infer<typeof houseLayoutSchema>;
export type Room = HouseLayout['rooms'][number];
export type Opening = HouseLayout['openings'][number];
export type DevicePlacement = HouseLayout['devices'][number];
export type Prop = HouseLayout['props'][number];
export type Built = HouseLayout['built'][number];
