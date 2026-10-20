/**
 * What the house shows for the home's live state: how each device looks, and the light outside
 * at the home's time of day. Pure functions, so the scene stays a drawing of these.
 */

export type Value = boolean | number | string;

/** A device as get_home_state reports it. */
export interface LiveDevice {
  id: string;
  kind: string;
  state: Record<string, Value>;
  sensor?: { trusted: boolean };
}

/** The parts of get_home_state the house draws. */
export interface LiveHome {
  now: string;
  mode: string;
  presence: Record<string, 'home' | 'away'>;
  zones: { id: string; name: string; tempC: number }[];
  devices: LiveDevice[];
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

/** A colour part way from `a` to `b`, both "#rrggbb". */
export function mix(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t));
  const ch = (c: string, i: number) => Number.parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * k));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
