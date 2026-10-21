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
  /** A colour to multiply the model's own by, and how much to brighten it (the car's cover). */
  tint: z
    .object({ color: z.string().regex(/^#[0-9a-f]{6}$/), lighten: z.number().min(1).max(4) })
    .optional(),
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

const model = (name: string) => `/house/models/${name}.glb`;
const texture = (name: string) => `/house/textures/${name}.webp`;

export const houseLayout: HouseLayout = houseLayoutSchema.parse({
  name: 'Cedar Hollow',
  wallHeight: 2.6,
  cutHeight: 1.1,
  wallThickness: 0.12,
  rooms: [
    {
      id: 'garage',
      name: 'Garage',
      zone: 'garage',
      x: 0,
      z: 0,
      width: 5.5,
      depth: 9,
      floor: 'concrete',
    },
    {
      id: 'kitchen',
      name: 'Kitchen',
      zone: 'house',
      x: 5.5,
      z: 0,
      width: 5.5,
      depth: 3.6,
      floor: 'tile',
    },
    {
      id: 'living_room',
      name: 'Living room',
      zone: 'house',
      x: 5.5,
      z: 3.6,
      width: 5.5,
      depth: 5.4,
      floor: 'wood',
    },
    {
      id: 'bedroom_main',
      name: 'Main bedroom',
      zone: 'house',
      x: 11,
      z: 0,
      width: 4.5,
      depth: 4.6,
      floor: 'wood',
    },
    {
      id: 'bedroom_sam',
      name: "Sam's room",
      zone: 'house',
      x: 11,
      z: 4.6,
      width: 4.5,
      depth: 4.4,
      floor: 'wood',
    },
  ],
  openings: [
    // To the outside: the front door, the back door, the garage door and the bedroom window.
    {
      kind: 'door',
      from: { x: 8.4, z: 9 },
      to: { x: 9.3, z: 9 },
      bottom: 0,
      top: 2.05,
      device: 'front_door_lock',
    },
    {
      kind: 'door',
      from: { x: 10.0, z: 0 },
      to: { x: 10.9, z: 0 },
      bottom: 0,
      top: 2.05,
      device: 'back_door_lock',
    },
    { kind: 'garage_door', from: { x: 0.5, z: 9 }, to: { x: 4.7, z: 9 }, bottom: 0, top: 2.2 },
    {
      kind: 'window',
      from: { x: 13.6, z: 0 },
      to: { x: 14.8, z: 0 },
      bottom: 0.9,
      top: 2.1,
      device: 'window_bedroom_main',
    },
    // Inside.
    { kind: 'doorway', from: { x: 7.5, z: 3.6 }, to: { x: 9.9, z: 3.6 }, bottom: 0, top: 2.2 },
    { kind: 'doorway', from: { x: 5.5, z: 1.0 }, to: { x: 5.5, z: 1.9 }, bottom: 0, top: 2.05 },
    { kind: 'doorway', from: { x: 11, z: 3.65 }, to: { x: 11, z: 4.5 }, bottom: 0, top: 2.05 },
    { kind: 'doorway', from: { x: 11, z: 5.0 }, to: { x: 11, z: 5.9 }, bottom: 0, top: 2.05 },
  ],
  devices: [
    // Living room. Its walls are all cut, so what hangs on them sits below the cut.
    { device: 'thermostat_main', shape: 'thermostat', x: 6.6, y: 0.82, z: 3.67, facing: 0 },
    { device: 'plug_aquarium', shape: 'aquarium', x: 6.1, y: 0.55, z: 8.6, facing: 0 },
    // The TV faces the camera from the east wall, so its screen shows when it's on.
    { device: 'plug_tv', shape: 'tv', x: 10.7, y: 0.68, z: 7.4, facing: -90 },
    // The keypad side of the lock, on the outside of the front door, faces the camera.
    { device: 'front_door_lock', shape: 'door_lock', x: 9.15, y: 0.95, z: 9.07, facing: 0 },
    { device: 'occupancy_living', shape: 'motion_sensor', x: 10.93, y: 0.95, z: 6.05, facing: -90 },
    { device: 'light_living', shape: 'floor_lamp', x: 5.95, y: 0, z: 4.1, facing: 45 },
    { device: 'light_porch', shape: 'porch_light', x: 9.95, y: 0, z: 9.6, facing: 0 },
    // Kitchen: the north wall is a full-height back wall.
    { device: 'plug_coffee_maker', shape: 'coffee_maker', x: 6.0, y: 0.9, z: 0.28, facing: 0 },
    { device: 'dishwasher', shape: 'dishwasher', x: 8.65, y: 0, z: 0.31, facing: 0 },
    { device: 'dishwasher_latch', shape: 'latch_sensor', x: 8.65, y: 0.8, z: 0.62, facing: 0 },
    { device: 'back_door_lock', shape: 'door_lock', x: 10.12, y: 1.0, z: 0.07, facing: 0 },
    {
      device: 'back_door_contact',
      shape: 'contact_sensor',
      x: 10.45,
      y: 2.08,
      z: 0.07,
      facing: 0,
    },
    {
      device: 'occupancy_kitchen',
      shape: 'motion_sensor',
      x: 5.75,
      y: 2.3,
      z: 0.07,
      facing: 0,
    },
    {
      device: 'smoke_alarm_kitchen',
      shape: 'smoke_alarm',
      x: 9.0,
      y: 2.35,
      z: 0.07,
      facing: 0,
    },
    { device: 'light_kitchen', shape: 'pendant_light', x: 8.3, y: 1.8, z: 2.2, facing: 0 },
    // Main bedroom.
    {
      device: 'plug_bedroom_space_heater',
      shape: 'space_heater',
      x: 12.1,
      y: 0,
      z: 3.4,
      facing: -30,
    },
    {
      device: 'window_bedroom_main',
      shape: 'contact_sensor',
      x: 14.72,
      y: 1.55,
      z: 0.07,
      facing: 0,
    },
    { device: 'light_bedroom_main', shape: 'bedside_lamp', x: 15.2, y: 0.55, z: 1.15, facing: -90 },
    // Sam's room.
    { device: 'light_bedroom_sam', shape: 'desk_lamp', x: 13.3, y: 0.76, z: 4.85, facing: 180 },
    // Garage: the thermostat on the full-height north wall, near the heater it runs.
    { device: 'garage_thermostat', shape: 'thermostat', x: 4.4, y: 1.5, z: 0.07, facing: 0 },
    { device: 'plug_garage_freezer', shape: 'chest_freezer', x: 1.4, y: 0, z: 0.4, facing: 0 },
  ],
  props: [
    // Living room.
    { model: model('modern_wooden_cabinet'), room: 'living_room', x: 10.72, z: 7.4, facing: -90 },
    { model: model('modern_coffee_table_01'), room: 'living_room', x: 8.9, z: 7.4 },
    { model: model('potted_plant_04'), room: 'living_room', x: 8.9, y: 0.39, z: 7.0 },
    { model: model('sofa_02'), room: 'living_room', x: 7.3, z: 7.4, facing: 90 },
    { model: model('modern_arm_chair_01'), room: 'living_room', x: 6.4, z: 5.0, facing: 135 },
    { model: model('side_table_01'), room: 'living_room', x: 6.1, z: 8.6 },
    // Kitchen.
    { model: model('electric_stove'), room: 'kitchen', x: 7.35, z: 0.33 },
    { model: model('round_wooden_table_01'), room: 'kitchen', x: 8.3, z: 2.2, scale: 0.75 },
    { model: model('painted_wooden_chair_01'), room: 'kitchen', x: 7.55, z: 2.2, facing: 90 },
    { model: model('painted_wooden_chair_01'), room: 'kitchen', x: 9.05, z: 2.2, facing: -90 },
    { model: model('painted_wooden_chair_01'), room: 'kitchen', x: 8.3, z: 2.95, facing: 180 },
    // Main bedroom.
    {
      model: model('throw_pillows_01'),
      room: 'bedroom_main',
      x: 15.05,
      y: 0.55,
      z: 2.3,
      facing: -90,
    },
    { model: model('side_table_01'), room: 'bedroom_main', x: 15.2, z: 1.15, facing: -90 },
    { model: model('side_table_01'), room: 'bedroom_main', x: 15.2, z: 3.45, facing: -90 },
    { model: model('vintage_wooden_drawer_01'), room: 'bedroom_main', x: 12.5, z: 0.55 },
    // Sam's room.
    { model: model('schooldesk_01'), room: 'bedroom_sam', x: 13.0, z: 4.95 },
    { model: model('schoolchair_01'), room: 'bedroom_sam', x: 13.0, z: 5.6, facing: 180 },
    {
      model: model('wooden_display_shelves_01'),
      room: 'bedroom_sam',
      x: 15.3,
      z: 5.6,
      facing: -90,
    },
    {
      model: model('rubber_duck_toy'),
      room: 'bedroom_sam',
      x: 14.0,
      y: 0.5,
      z: 8.4,
      facing: -30,
    },
    // Garage.
    // A lighter cover, so the car doesn't swallow the garage.
    {
      model: model('covered_car'),
      room: 'garage',
      x: 2.7,
      z: 5.3,
      tint: { color: '#c8d0d8', lighten: 2.6 },
    },
    {
      model: model('steel_frame_shelves_01'),
      room: 'garage',
      x: 0.3,
      z: 1.9,
      facing: 90,
      scale: 0.1,
    },
    { model: model('cardboard_box_01'), room: 'garage', x: 0.45, z: 2.9, facing: 10 },
    { model: model('plastic_crate_02'), room: 'garage', x: 0.5, z: 3.6, facing: 90 },
    { model: model('wooden_ladder'), room: 'garage', x: 5.05, z: 7.6, facing: -90 },
    // The tyre's origin is its centre.
    { model: model('old_tyre'), room: 'garage', x: 0.15, y: 0.3, z: 7.0, facing: 90 },
  ],
  built: [
    // Kitchen counters either side of the stove and the dishwasher.
    { shape: 'counter', room: 'kitchen', x: 6.33, z: 0.31, width: 1.55, depth: 0.62, height: 0.9 },
    { shape: 'counter', room: 'kitchen', x: 7.98, z: 0.31, width: 0.75, depth: 0.62, height: 0.9 },
    { shape: 'counter', room: 'kitchen', x: 9.33, z: 0.31, width: 0.75, depth: 0.62, height: 0.9 },
    {
      shape: 'bed',
      room: 'bedroom_main',
      x: 14.47,
      z: 2.3,
      width: 1.6,
      depth: 2.05,
      height: 0.55,
      facing: -90,
    },
    {
      shape: 'bed',
      room: 'bedroom_sam',
      x: 14.52,
      z: 8.4,
      width: 0.9,
      depth: 1.95,
      height: 0.5,
      facing: -90,
    },
    { shape: 'rug', room: 'living_room', x: 8.6, z: 7.3, width: 2.6, depth: 2.6, height: 0.012 },
    { shape: 'rug', room: 'bedroom_main', x: 13.2, z: 2.3, width: 1.3, depth: 2.2, height: 0.012 },
    {
      shape: 'wall_heater',
      room: 'garage',
      x: 3.2,
      y: 1.7,
      z: 0.15,
      width: 0.8,
      depth: 0.18,
      height: 0.45,
      drivenBy: 'garage_thermostat',
    },
  ],
  people: [
    { member: 'om', x: 9.6, z: 5.4, facing: -30, color: '#4f7cac' },
    { member: 'maya', x: 9.7, z: 1.3, facing: 160, color: '#b05a6a' },
    { member: 'sam', x: 12.4, z: 6.9, facing: 20, color: '#c9a227', scale: 0.8 },
  ],
  floors: {
    wood: {
      color: texture('wood_floor_diff'),
      normal: texture('wood_floor_nor_gl'),
      arm: texture('wood_floor_arm'),
      tile: 2,
    },
    tile: {
      color: texture('floor_tiles_06_diff'),
      normal: texture('floor_tiles_06_nor_gl'),
      arm: texture('floor_tiles_06_arm'),
      tile: 1.5,
    },
    concrete: {
      color: texture('concrete_floor_worn_001_diff'),
      normal: texture('concrete_floor_worn_001_nor_gl'),
      arm: texture('concrete_floor_worn_001_arm'),
      tile: 3,
    },
  },
  environment: '/house/env/belfast_sunset_puresky_1k.hdr',
});
