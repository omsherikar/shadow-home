import { describe, expect, test } from 'vitest';
import type { LiveDevice } from './looks.ts';
import type { Break, Change, Run } from './playback.ts';
import { changeWords, stepWords, summaryOf } from './words.ts';

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

describe('what a run came to', () => {
  const at = (local: string) => Date.parse(`${local}-06:00`);
  const broke = (rule: string, local: string): Break => ({
    kind: 'violation',
    atMs: at(local),
    rule,
    text: '',
    author: 'om',
  });
  const base: Run = {
    planId: 'p',
    label: 'Your plan',
    tone: 'plan',
    verdict: 'UNSAFE',
    startMs: at('2027-01-15T17:53:00'),
    endMs: at('2027-01-17T18:00:00'),
    offset: '-06:00',
    changes: [],
    steps: [],
    breaks: [],
    trace: null,
    limits: { garage: { minC: 4, maxC: null } },
    temperatureRules: { R3: { zone: 'garage', zoneName: 'Garage', minC: 4, maxC: null } },
    presence: [],
  };
  const names = (id: string) => ({ dishwasher_latch: 'Dishwasher door latch' })[id];
  const zones = (id: string) => ({ garage: 'Garage' })[id];

  test('a plan that breaks rules says how many, and when the room gets too cold', () => {
    const run: Run = {
      ...base,
      breaks: [
        broke('R1', '2027-01-15T17:53:00'),
        broke('R2', '2027-01-15T17:53:00'),
        broke('R8', '2027-01-16T07:00:00'),
        broke('R3', '2027-01-16T22:37:00'),
      ],
    };
    expect(summaryOf(run, names, zones)).toBe(
      'Your plan: 4 house rules break; the garage drops below 4 °C Sat 10:37 PM.',
    );
  });

  test('without a temperature rule broken, it gives the first break’s time', () => {
    const run: Run = { ...base, breaks: [broke('R8', '2027-01-16T07:00:00')] };
    expect(summaryOf(run, names, zones)).toBe(
      'Your plan: 1 house rule breaks; the first Sat 7:00 AM.',
    );
  });

  test('a rule that might break is counted as such', () => {
    const run: Run = {
      ...base,
      breaks: [{ ...broke('R3', '2027-01-16T22:37:00'), kind: 'not_robust' }],
    };
    expect(summaryOf(run, names, zones)).toBe(
      'Your plan: 1 might break, depending on the weather.',
    );
  });

  test('a rule with both limits says which one the room crossed, from its temperature then', () => {
    const between = { zone: 'house', zoneName: 'House', minC: 16, maxC: 26 };
    const trace = (houseC: number) => ({
      start: '2027-01-15T17:53:00-06:00',
      end: '2027-01-17T18:00:00-06:00',
      stepMinutes: 15,
      outdoorC: [1, 1],
      zonesC: {
        nominal: { house: [houseC, houseC] },
        pessimistic: { house: [houseC, houseC] },
        optimistic: { house: [houseC, houseC] },
      },
    });
    const run = (houseC: number | null): Run => ({
      ...base,
      temperatureRules: { R5: between },
      trace: houseC === null ? null : trace(houseC),
      breaks: [broke('R5', '2027-01-16T03:00:00')],
    });
    expect(summaryOf(run(15.4), names, zones)).toBe(
      'Your plan: 1 house rule breaks; the house drops below 16 °C Sat 3:00 AM.',
    );
    expect(summaryOf(run(26.6), names, zones)).toBe(
      'Your plan: 1 house rule breaks; the house goes above 26 °C Sat 3:00 AM.',
    );
    expect(summaryOf(run(null), names, zones)).toBe(
      'Your plan: 1 house rule breaks; the house goes outside 16 to 26 °C Sat 3:00 AM.',
    );
    // Held, it stays between them.
    expect(summaryOf({ ...run(20), verdict: 'SAFE', breaks: [] }, names, zones)).toBe(
      'Your plan: every house rule holds, and the house stays between 16 and 26 °C.',
    );
  });
});
