import { z } from 'zod';

// Shape only. Whether a device, attribute or value makes sense for a given home is the
// engine's lint stage; whether the home's own references line up is validateHome.

export const isoDateTime = z.iso.datetime({ offset: true });
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const id = z.string().min(1);

export const valueSchema = z.union([z.boolean(), z.number(), z.string()]);
export type Value = z.infer<typeof valueSchema>;

// ---- Conditions (shared by rules, routines and plans) ----

export type StateCond =
  | { device: string; attr: string; eq: Value }
  | { device: string; attr: string; neq: Value };

export type PresenceCond =
  | { presence: 'nobody' | 'anyone' }
  | { presence: { member: string; is: 'home' | 'away' } };

export type Cond =
  | StateCond
  | PresenceCond
  | { time: { from: string; to: string } }
  | { any: Cond[] }
  | { all: Cond[] }
  | { not: Cond };

export const stateCondSchema: z.ZodType<StateCond> = z.union([
  z.strictObject({ device: id, attr: id, eq: valueSchema }),
  z.strictObject({ device: id, attr: id, neq: valueSchema }),
]);

const presenceCondSchema: z.ZodType<PresenceCond> = z.union([
  z.strictObject({ presence: z.enum(['nobody', 'anyone']) }),
  z.strictObject({
    presence: z.strictObject({ member: id, is: z.enum(['home', 'away']) }),
  }),
]);

export const condSchema: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    stateCondSchema,
    presenceCondSchema,
    z.strictObject({ time: z.strictObject({ from: clockTime, to: clockTime }) }),
    z.strictObject({ any: z.array(condSchema).min(1) }),
    z.strictObject({ all: z.array(condSchema).min(1) }),
    z.strictObject({ not: condSchema }),
  ]),
);

// ---- Devices ----

export const capabilitySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('boolean') }),
  z.strictObject({
    type: z.literal('number'),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
  }),
  z.strictObject({ type: z.literal('enum'), values: z.array(z.string()).min(1) }),
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const DEVICE_KINDS = [
  'thermostat',
  'plug',
  'appliance',
  'contact_sensor',
  'lock',
  'occupancy_sensor',
  'smoke_alarm',
  'light',
] as const;

export const sensorSchema = z.strictObject({
  batteryPercent: z.number().min(0).max(100).nullable(),
  lastReportMinutesAgo: z.number().min(0),
});
export type Sensor = z.infer<typeof sensorSchema>;

export const deviceSchema = z.strictObject({
  id,
  name: z.string(),
  room: id,
  kind: z.enum(DEVICE_KINDS),
  matter: z.strictObject({
    deviceType: z.string(),
    deviceTypeId: z.string().nullable(),
    clusters: z.array(z.string()).min(1),
  }),
  alexa: z.strictObject({ interfaces: z.array(z.string()) }),
  capabilities: z.record(z.string(), capabilitySchema),
  state: z.record(z.string(), valueSchema),
  sensor: sensorSchema.optional(),
  controlsZone: id.optional(),
  heatProducing: z.boolean().optional(),
  /** Attributes whose writes can't be taken back once they take effect. */
  irreversible: z.array(z.string()).optional(),
  outdoor: z.boolean().optional(),
  verify: z.string().optional(),
});
export type Device = z.infer<typeof deviceSchema>;

// ---- Routines ----

export const routineActionSchema = z.union([
  z.strictObject({
    device: id,
    set: z.record(z.string(), valueSchema),
    afterMinutes: z.number().int().min(0).optional(),
  }),
  z.strictObject({
    group: id,
    set: z.record(z.string(), valueSchema),
    afterMinutes: z.number().int().min(0).optional(),
  }),
]);

export const routineSchema = z.strictObject({
  id,
  name: z.string(),
  owner: id,
  enabled: z.boolean(),
  trigger: z.strictObject({ type: z.literal('time'), at: clockTime, days: z.literal('daily') }),
  actions: z.array(routineActionSchema).min(1),
  /** Paused by an earlier plan: triggers from now until this instant don't run. */
  pausedUntil: isoDateTime.optional(),
});
export type Routine = z.infer<typeof routineSchema>;

// ---- House rules (five templates) ----

export const RULE_PRIORITIES = ['life-safety', 'security', 'device-protection', 'comfort'] as const;
export type RulePriority = (typeof RULE_PRIORITIES)[number];

const ruleBase = {
  id,
  text: z.string(),
  author: id,
  priority: z.enum(RULE_PRIORITIES),
  refuse: z.boolean().optional(),
  source: z.string().optional(),
};

export const ruleSchema = z.discriminatedUnion('template', [
  z.strictObject({
    ...ruleBase,
    template: z.literal('always'),
    params: z.strictObject({ state: stateCondSchema }),
  }),
  z.strictObject({
    ...ruleBase,
    template: z.literal('never_when'),
    params: z.strictObject({ x: condSchema, when: condSchema }),
  }),
  z.strictObject({
    ...ruleBase,
    template: z.literal('keep_between'),
    params: z.strictObject({
      quantity: z.strictObject({ zone: id, attr: z.literal('temperatureC') }),
      min: z.number().nullable(),
      max: z.number().nullable(),
      when: condSchema.nullable(),
    }),
  }),
  z.strictObject({
    ...ruleBase,
    template: z.literal('within_after'),
    params: z.strictObject({
      minutes: z.number().int().positive(),
      after: condSchema,
      ensure: z.array(stateCondSchema).min(1),
    }),
  }),
  z.strictObject({
    ...ruleBase,
    template: z.literal('never_together'),
    params: z.strictObject({ a: condSchema, b: condSchema }),
  }),
]);
export type Rule = z.infer<typeof ruleSchema>;

// ---- Home ----

export const HOME_MODES = ['home', 'away'] as const;
export type HomeMode = (typeof HOME_MODES)[number];

const runParamsSchema = z.strictObject({
  uaMultiplier: z.number().positive(),
  forecastOffsetC: z.number(),
});

export const homeSchema = z.object({
  version: z.literal(1),
  home: z.strictObject({
    id,
    name: z.string(),
    timezone: z.string(),
    utcOffset: z.string().regex(/^[+-]\d{2}:\d{2}$/, 'expected an offset like -06:00'),
  }),
  clock: z.strictObject({ now: isoDateTime }),
  household: z.strictObject({
    members: z.array(
      z.strictObject({
        id,
        name: z.string(),
        role: z.enum(['owner', 'adult', 'teen', 'child', 'guest']),
      }),
    ),
    presence: z.record(z.string(), z.enum(['home', 'away'])),
    presenceSource: z.string(),
  }),
  mode: z.enum(HOME_MODES),
  rooms: z.array(z.strictObject({ id, name: z.string(), zone: id })),
  zones: z.array(
    z.strictObject({
      id,
      name: z.string(),
      initialTempC: z.number(),
      uaOutWPerK: z.number().positive(),
      heatCapacityJPerK: z.number().positive(),
      heater: z.strictObject({ thermostat: id, maxPowerW: z.number().positive() }),
    }),
  ),
  couplings: z.array(
    z.strictObject({ zones: z.tuple([id, id]), uaWPerK: z.number().nonnegative() }),
  ),
  internalGains: z.array(
    z.strictObject({ device: id, zone: id, wattsWhenOn: z.number().nonnegative() }),
  ),
  groups: z.record(z.string(), z.array(id).min(1)),
  devices: z.array(deviceSchema),
  routines: z.array(routineSchema),
  /** Writes an earlier plan scheduled for later. They run like routine steps. */
  scheduled: z
    .array(
      z.strictObject({
        device: id,
        set: z.record(z.string(), valueSchema),
        at: isoDateTime,
        /** What scheduled it, for the timeline and the activity log. */
        source: z.string().min(1),
      }),
    )
    .optional(),
  rules: z.array(ruleSchema),
  rulePriorityOrder: z.array(z.enum(RULE_PRIORITIES)),
  forecast: z.strictObject({
    source: z.string(),
    uncertaintyC: z.number().nonnegative(),
    hourly: z.array(z.strictObject({ time: isoDateTime, tempC: z.number() })).min(2),
  }),
  simulation: z.strictObject({
    stepMinutes: z.number().int().positive(),
    maxHorizonHours: z.number().positive(),
    horizonAfterLastActionHours: z.number().positive(),
    thermostatHysteresisC: z.number().nonnegative(),
    loopGuardActionsPerStep: z.number().int().positive(),
    staleSensorMinutes: z.number().positive(),
    lowBatteryPercent: z.number().min(0).max(100),
    runs: z.strictObject({
      nominal: runParamsSchema,
      pessimistic: runParamsSchema,
      optimistic: runParamsSchema,
    }),
  }),
});
export type Home = z.infer<typeof homeSchema>;

// ---- Plans (what an assistant proposes; preview_plan input and bench plan body) ----

const setSchema = z
  .record(z.string(), valueSchema)
  .refine((s) => Object.keys(s).length > 0, 'set must change at least one attribute');

export const planActionSchema = z.union([
  z.strictObject({ device: id, set: setSchema, at: isoDateTime.optional() }),
  z.strictObject({ group: id, set: setSchema, at: isoDateTime.optional() }),
  z.strictObject({ routine: id, pauseUntil: isoDateTime }),
  z.strictObject({ mode: z.string().min(1), at: isoDateTime.optional() }),
]);
export type PlanAction = z.infer<typeof planActionSchema>;

export const presenceSpecSchema = z.union([
  z.enum(['nobody', 'everyone']),
  z.strictObject({ home: z.array(id) }),
]);
export type PresenceSpec = z.infer<typeof presenceSpecSchema>;

export const planContextSchema = z.strictObject({
  now: isoDateTime,
  presenceSchedule: z
    .array(z.strictObject({ from: isoDateTime, to: isoDateTime, presence: presenceSpecSchema }))
    .optional(),
  planEnd: isoDateTime.nullable().optional(),
  stateOverrides: z
    .record(
      z.string(),
      z.strictObject({
        state: z.record(z.string(), valueSchema).optional(),
        sensor: sensorSchema.partial().optional(),
      }),
    )
    .optional(),
});
export type PlanContext = z.infer<typeof planContextSchema>;

/** Bench files carry extra keys (set, home, source, notes); they are dropped here. */
export const planSchema = z.object({
  id: z.string().optional(),
  request: z.string().optional(),
  context: planContextSchema,
  actions: z.array(planActionSchema),
});
export type Plan = z.infer<typeof planSchema>;
