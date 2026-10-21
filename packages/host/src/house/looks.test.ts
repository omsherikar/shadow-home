import { describe, expect, test } from 'vitest';
import {
  daylight,
  dotFor,
  type LiveDevice,
  lookOf,
  mix,
  parseLiveHome,
  skyColors,
} from './looks.ts';

const device = (kind: string, state: LiveDevice['state'], trusted?: boolean): LiveDevice => ({
  id: 'd',
  kind,
  state,
  ...(trusted === undefined ? {} : { sensor: { trusted } }),
});

describe('how a device looks', () => {
  test('a light glows by its brightness, and not at all when off', () => {
    expect(lookOf(device('light', { onOff: true, brightness: 70 })).glow).toBe(0.7);
    expect(lookOf(device('light', { onOff: true })).glow).toBe(1);
    expect(lookOf(device('light', { onOff: false, brightness: 70 })).glow).toBe(0);
  });

  test('a plug or appliance lights what it powers while on', () => {
    expect(lookOf(device('plug', { onOff: true })).glow).toBe(1);
    expect(lookOf(device('appliance', { onOff: false })).glow).toBe(0);
  });

  test('a lock shows open in amber when unlocked', () => {
    expect(lookOf(device('lock', { lockState: 'LOCKED' }))).toMatchObject({
      status: 'ok',
      open: false,
    });
    expect(lookOf(device('lock', { lockState: 'UNLOCKED' }))).toMatchObject({
      status: 'warn',
      open: true,
    });
  });

  test('a window or door sensor shows open', () => {
    expect(lookOf(device('contact_sensor', { contact: 'open' })).open).toBe(true);
    expect(lookOf(device('contact_sensor', { contact: 'closed' })).open).toBe(false);
  });

  test('a smoke alarm in alarm glows red; switched off it is dark', () => {
    expect(lookOf(device('smoke_alarm', { smokeState: 'critical', enabled: true }))).toMatchObject({
      status: 'alarm',
      glow: 1,
    });
    expect(lookOf(device('smoke_alarm', { smokeState: 'normal', enabled: false })).status).toBe(
      'off',
    );
  });

  test('a thermostat glows warm while it heats, dim when it doesn’t need to, dark when off', () => {
    const t = (mode: string, temp: number) =>
      lookOf(
        device('thermostat', { systemMode: mode, heatingSetpointC: 20, localTemperatureC: temp }),
      );
    expect(t('heat', 18).glow).toBe(1);
    expect(t('heat', 21).glow).toBeGreaterThan(0);
    expect(t('heat', 21).glow).toBeLessThan(1);
    expect(t('off', 18).glow).toBe(0);
  });

  test('a sensor the twin can’t trust shows its reading as unknown', () => {
    expect(lookOf(device('contact_sensor', { contact: 'closed' }, false)).status).toBe('unknown');
    expect(lookOf(device('contact_sensor', { contact: 'closed' }, true)).status).toBe('ok');
  });

  test('a device the home doesn’t report is drawn dark', () => {
    expect(lookOf(undefined)).toEqual({ glow: 0, status: 'off', open: false });
  });
});

describe('the light outside', () => {
  const at = (hhmm: string) => daylight(`2027-01-15T${hhmm}:00-06:00`);

  test('noon is brighter than dusk, and dusk than midnight', () => {
    expect(at('12:30').key).toBeGreaterThan(at('17:45').key);
    expect(at('17:45').key).toBeGreaterThan(at('23:30').key);
    expect(at('12:30').sky).toBeGreaterThan(at('23:30').sky);
  });

  test('the demo starts at dusk: the sun just down, the light warm and fading', () => {
    const dusk = at('17:45');
    expect(dusk.elevation).toBeLessThan(0);
    expect(dusk.elevation).toBeGreaterThan(-6);
    expect(dusk.day).toBeGreaterThan(0.05);
    expect(dusk.day).toBeLessThan(0.5);
  });

  test('the key light always shines from above', () => {
    for (const hhmm of ['02:00', '07:00', '12:30', '17:45', '22:30']) {
      const [x, y, z] = at(hhmm).direction;
      expect(y, hhmm).toBeGreaterThan(0.2);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
    }
  });

  test('the same time gives the same light', () => {
    expect(at('17:45')).toEqual(at('17:45'));
  });

  test('colours mix part way, end to end', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#000000', '#ffffff', 2)).toBe('#ffffff');
  });
});

describe('status dots', () => {
  test('say what a lock, a plug and a thermostat are doing', () => {
    expect(dotFor(device('lock', { lockState: 'LOCKED' }))).toEqual({
      tone: 'locked',
      label: 'Locked',
    });
    expect(dotFor(device('lock', { lockState: 'UNLOCKED' })).tone).toBe('unlocked');
    expect(dotFor(device('plug', { onOff: true })).tone).toBe('on');
    expect(dotFor(device('plug', { onOff: false })).tone).toBe('off');
    const t = (mode: string, temp: number) =>
      dotFor(
        device('thermostat', { systemMode: mode, heatingSetpointC: 9, localTemperatureC: temp }),
      );
    expect(t('heat', 8)).toEqual({ tone: 'heating', label: 'Heating to 9 °C' });
    expect(t('heat', 9.5)).toEqual({ tone: 'idle', label: 'Set to 9 °C' });
    expect(t('off', 3).tone).toBe('off');
  });
});

describe('the sky', () => {
  const sky = (hhmm: string) => skyColors(daylight(`2027-01-15T${hhmm}:00-06:00`));
  const light = (hex: string) =>
    [1, 3, 5].reduce((t, i) => t + Number.parseInt(hex.slice(i, i + 2), 16), 0);

  test('is dark at night, pale by day, and glows warm at the horizon around sunset', () => {
    expect(light(sky('23:30').top)).toBeLessThan(light(sky('17:45').top));
    expect(light(sky('17:45').top)).toBeLessThan(light(sky('12:30').top));
    const dusk = sky('17:40').horizon;
    expect(Number.parseInt(dusk.slice(1, 3), 16)).toBeGreaterThan(
      Number.parseInt(dusk.slice(5, 7), 16),
    );
  });
});

describe('the home as get_home_state reports it', () => {
  const home = {
    now: '2027-01-15T17:45:00-06:00',
    mode: 'home',
    stateVersion: 3,
    presence: { om: 'home' },
    zones: [{ id: 'garage', name: 'Garage', tempC: 9 }],
    devices: [
      { id: 'plug_tv', name: 'TV', room: 'living_room', kind: 'plug', state: { onOff: true } },
    ],
    routines: [],
  };

  test('keeps what the page reads and drops the rest', () => {
    expect(parseLiveHome(home)).toEqual({
      now: home.now,
      mode: 'home',
      presence: { om: 'home' },
      zones: home.zones,
      devices: [{ id: 'plug_tv', name: 'TV', kind: 'plug', state: { onOff: true } }],
    });
  });

  test('is refused when it isn’t what the page expects', () => {
    expect(parseLiveHome(undefined)).toBeNull();
    expect(parseLiveHome({ ...home, zones: 'warm' })).toBeNull();
    expect(parseLiveHome({ ...home, presence: { om: 'out' } })).toBeNull();
    expect(parseLiveHome({ ...home, devices: [{ id: 'plug_tv', state: {} }] })).toBeNull();
    expect(
      parseLiveHome({ ...home, devices: [{ id: 'x', kind: 'plug', state: { onOff: [] } }] }),
    ).toBeNull();
  });
});
