import { describe, expect, test } from 'vitest';
import type { LiveDevice } from './looks.ts';
import type { Change } from './playback.ts';
import { changeWords, stepWords } from './words.ts';

const device = (id: string, name: string, kind = 'plug'): LiveDevice => ({
  id,
  name,
  kind,
  state: {},
});
const change = (d: string, attr: string, to: Change['to']): Change => ({
  atMs: 0,
  device: d,
  attr,
  to,
  source: 'plan',
});

describe('a change in words', () => {
  test('says what happens to the device, by its name', () => {
    const freezer = device('plug_garage_freezer', 'Garage freezer');
    expect(changeWords(change('plug_garage_freezer', 'onOff', false), freezer)).toBe(
      'Garage freezer off',
    );
    expect(changeWords(change('x', 'onOff', true), device('x', 'Coffee maker'))).toBe(
      'Coffee maker on',
    );
    expect(
      changeWords(change('front_door_lock', 'lockState', 'LOCKED'), device('l', 'Front door lock')),
    ).toBe('Front door locked');
    expect(changeWords(change('t', 'heatingSetpointC', 10), device('t', 'Main thermostat'))).toBe(
      'Main thermostat to 10 °C',
    );
    expect(changeWords(change('g', 'systemMode', 'off'), device('g', 'Garage heater'))).toBe(
      'Garage heater off',
    );
  });

  test('a device the home doesn’t name goes by its ID', () => {
    expect(changeWords(change('mystery', 'onOff', false), undefined)).toBe('mystery off');
  });

  test('the lights one action turns off together are counted, not listed', () => {
    const lights = ['a', 'b', 'c', 'd'].map((id) => device(id, `Light ${id}`, 'light'));
    expect(
      stepWords(
        lights.map((l) => change(l.id, 'onOff', false)),
        lights,
      ),
    ).toBe('4 lights off');
    expect(stepWords([change('a', 'onOff', false)], lights)).toBe('Light a off');
  });
});
