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
});
