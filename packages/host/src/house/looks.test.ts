import { describe, expect, test } from 'vitest';
import { type LiveDevice, lookOf } from './looks.ts';

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
