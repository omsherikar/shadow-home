/**
 * What the house shows for the home's live state: how each device looks, and the light outside
 * at the home's time of day. Pure functions, so the scene stays a drawing of these.
 */
import { z } from 'zod';

/** A device attribute's value, as the server reports it. */
export const valueSchema = z.union([z.boolean(), z.number(), z.string()]);

/** The parts of get_home_state the page reads. Anything else in the result is dropped. */
export const liveHomeSchema = z.object({
  now: z.string(),
  mode: z.string(),
  presence: z.record(z.string(), z.enum(['home', 'away'])),
  zones: z.array(z.object({ id: z.string(), name: z.string(), tempC: z.number() })),
  devices: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      kind: z.string(),
      state: z.record(z.string(), valueSchema),
      sensor: z.object({ trusted: z.boolean() }).optional(),
    }),
  ),
});

export type LiveHome = z.infer<typeof liveHomeSchema>;
export type LiveDevice = LiveHome['devices'][number];
export type Value = z.infer<typeof valueSchema>;

/** The home from a get_home_state result, or null when it isn't what the page expects. */
export function parseLiveHome(structured: unknown): LiveHome | null {
  const parsed = liveHomeSchema.safeParse(structured);
  return parsed.success ? parsed.data : null;
}

export interface Look {
  /** Light the device gives off: 0 is dark, 1 full. */
  glow: number;
  /** Its status light: fine, worth a look, alarming, off, or a reading the twin can't trust. */
  status: 'ok' | 'warn' | 'alarm' | 'off' | 'unknown';
  /** A door unlocked or a window open. */
  open: boolean;
}

const DARK: Look = { glow: 0, status: 'off', open: false };

/** How a device looks in a given state. A device the home doesn't report is drawn dark. */
export function lookOf(device: LiveDevice | undefined): Look {
  if (!device) return DARK;
  const s = device.state;
  const look = ((): Look => {
    switch (device.kind) {
      case 'light': {
        if (s.onOff !== true) return DARK;
        const level = typeof s.brightness === 'number' ? s.brightness / 100 : 1;
        return { glow: Math.min(1, Math.max(0.15, level)), status: 'ok', open: false };
      }
      case 'plug':
      case 'appliance':
        return s.onOff === true ? { glow: 1, status: 'ok', open: false } : DARK;
      case 'lock':
        if (s.lockState === 'LOCKED') return { glow: 0, status: 'ok', open: false };
        if (s.lockState === 'UNLOCKED') return { glow: 0, status: 'warn', open: true };
        return { glow: 0, status: 'alarm', open: false };
      case 'contact_sensor':
        return s.contact === 'open'
          ? { glow: 0, status: 'warn', open: true }
          : { glow: 0, status: 'ok', open: false };
      case 'occupancy_sensor':
        return { glow: s.occupied === true ? 1 : 0, status: 'ok', open: false };
      case 'smoke_alarm':
        if (s.enabled === false) return DARK;
        if (s.smokeState === 'critical') return { glow: 1, status: 'alarm', open: false };
        if (s.smokeState === 'warning') return { glow: 0.6, status: 'warn', open: false };
        return { glow: 0, status: 'ok', open: false };
      case 'thermostat': {
        if (s.systemMode !== 'heat') return DARK;
        const t = s.localTemperatureC;
        const set = s.heatingSetpointC;
        const heating = typeof t === 'number' && typeof set === 'number' && t < set;
        return { glow: heating ? 1 : 0.35, status: 'ok', open: false };
      }
      default:
        return DARK;
    }
  })();
  // A low battery or a silent sensor: whatever it says can't be relied on.
  return device.sensor?.trusted === false ? { ...look, status: 'unknown' } : look;
}

export interface Daylight {
  /** Sun's height above the horizon in degrees; negative after sunset. */
  elevation: number;
  /** 0 at night, 1 in full day. */
  day: number;
  /** Strength and colour of the key light (the sun, or the moon at night). */
  key: number;
  keyColor: string;
  /** Strength of the sky's light on the house. */
  sky: number;
  /** Unit vector from the house towards the key light (x east, y up, z south). */
  direction: [number, number, number];
}

// The demo home is in January: the sun is up from about 7:25 AM to 5:35 PM and stays low.
const SUNRISE = 7.4;
const SUNSET = 17.6;
const NOON_ELEVATION = 30;

/** The light outside at a home time ("2027-01-15T17:45:00-06:00", read as the home's clock). */
export function daylight(iso: string): Daylight {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  const hour = m ? Number(m[1]) + Number(m[2]) / 60 : 12;
  const elevation = NOON_ELEVATION * Math.sin((Math.PI * (hour - SUNRISE)) / (SUNSET - SUNRISE));
  const day = smoothstep(-6, 10, elevation);
  // Outside the light cools as the day goes: moonlight, then a blue-violet dusk, then the sun.
  const night = '#8fa6ff';
  const dusk = '#aeb0e8';
  const noon = '#fff3e0';
  const keyColor = day < 0.4 ? mix(night, dusk, day / 0.4) : mix(dusk, noon, (day - 0.4) / 0.6);
  // The sun crosses from south-east to south-west; at night a moon hangs high in the south-east.
  const up = elevation > -3;
  const azimuth = up
    ? 120 + 120 * Math.min(1, Math.max(0, (hour - SUNRISE) / (SUNSET - SUNRISE)))
    : 150;
  const height = up ? Math.max(elevation, 12) : 35;
  const a = (azimuth * Math.PI) / 180;
  const e = (height * Math.PI) / 180;
  return {
    elevation,
    day,
    key: 0.3 + 2.2 * day,
    keyColor,
    sky: 0.22 + 0.78 * day,
    direction: [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)],
  };
}

/** The sky behind the house at a moment: its top, the band at the horizon, and the far ground. */
export interface Sky {
  top: string;
  horizon: string;
  ground: string;
}

/** Night navy, a dusk of violet over an orange glow, or a pale day: from the light outside. */
export function skyColors(light: Daylight): Sky {
  const d = light.day;
  // The glow at the horizon is strongest around sunset and sunrise, when the sun is near it.
  const glow = Math.max(0, 1 - Math.abs(light.elevation) / 9);
  const top =
    d < 0.45 ? mix('#0b1228', '#352f5c', d / 0.45) : mix('#352f5c', '#6fa2d6', (d - 0.45) / 0.55);
  const clear =
    d < 0.45 ? mix('#16203e', '#5a4c7c', d / 0.45) : mix('#5a4c7c', '#cfe1f1', (d - 0.45) / 0.55);
  return {
    top,
    horizon: mix(clear, '#f0a26f', glow * 0.75),
    ground:
      d < 0.45 ? mix('#0d120f', '#232a22', d / 0.45) : mix('#232a22', '#56643f', (d - 0.45) / 0.55),
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** A colour part way from `a` to `b`, both "#rrggbb". */
export function mix(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t));
  const ch = (c: string, i: number) => Number.parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * k));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
