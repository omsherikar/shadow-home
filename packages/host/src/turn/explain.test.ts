import { describe, expect, test } from 'vitest';
import { explainBreaks } from './explain.ts';

const names = {
  'shadow-home/names': {
    devices: {
      plug_coffee_maker: { name: 'Coffee maker', room: 'Kitchen' },
      garage_thermostat: { name: 'Garage heater thermostat', room: 'Garage' },
    },
    routines: { coffee_at_7: 'Coffee at 7' },
    members: { om: 'Om', maya: 'Maya' },
  },
};

const weekend = {
  horizon: { start: '2027-01-15T17:45:00-06:00', end: '2027-01-18T17:45:00-06:00' },
  violations: [
    {
      rule: 'R8',
      text: "No coffee maker running when nobody's home.",
      author: 'om',
      firstAt: '2027-01-16T07:00:00-06:00',
      cause: {
        at: '2027-01-16T07:00:00-06:00',
        source: 'coffee_at_7',
        device: 'plug_coffee_maker',
        attr: 'onOff',
        to: true,
      },
    },
    {
      rule: 'R3',
      text: "Don't let the garage pipes freeze.",
      author: 'om',
      firstAt: '2027-01-16T22:18:00-06:00',
      cause: {
        at: '2027-01-15T17:45:00-06:00',
        source: 'plan',
        device: 'garage_thermostat',
        attr: 'systemMode',
        to: 'off',
      },
    },
    // The same rule again from another run is said once.
    {
      rule: 'R3',
      text: "Don't let the garage pipes freeze.",
      author: 'om',
      firstAt: '2027-01-16T21:40:00-06:00',
    },
  ],
};

describe('every broken rule in plain words', () => {
  test('the weekend: the routine that turns the coffee maker on, and the garage heater off', () => {
    expect(explainBreaks(weekend, names)).toBe(
      'Coffee at 7 turns the coffee maker on at Sat 7:00 AM, which breaks Om\'s rule: "No coffee maker running when nobody\'s home." ' +
        "Your plan turns the garage heater thermostat's heating off, and by Sat 10:18 PM that breaks Om's rule: \"Don't let the garage pipes freeze.\"",
    );
  });

  test('a rule broken right away by the plan', () => {
    const now = {
      horizon: weekend.horizon,
      violations: [
        {
          rule: 'R1',
          text: 'Never turn off the garage freezer.',
          author: 'om',
          firstAt: '2027-01-15T17:45:00-06:00',
          cause: {
            at: '2027-01-15T17:45:00-06:00',
            source: 'plan',
            device: 'plug_garage_freezer',
            attr: 'onOff',
            to: false,
          },
        },
      ],
    };
    const withFreezer = {
      'shadow-home/names': {
        ...names['shadow-home/names'],
        devices: { plug_garage_freezer: { name: 'Garage freezer', room: 'Garage' } },
      },
    };
    expect(explainBreaks(now, withFreezer)).toBe(
      'Your plan turns the garage freezer off, which breaks Om\'s rule: "Never turn off the garage freezer."',
    );
  });

  test('more than four rules: four are said and the rest are on the screen', () => {
    const many = {
      horizon: weekend.horizon,
      violations: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'].map((rule) => ({
        rule,
        text: `Rule ${rule}.`,
        author: 'om',
        firstAt: '2027-01-16T07:00:00-06:00',
      })),
    };
    const said = explainBreaks(many, names) ?? '';
    expect(said.match(/breaks Om's rule/g)).toHaveLength(4);
    expect(said.endsWith('And 2 more rules on the screen.')).toBe(true);
  });

  test('a check with no broken rules gives nothing, so the engine reason is said', () => {
    expect(explainBreaks({ violations: [] }, names)).toBeUndefined();
    expect(explainBreaks(undefined, names)).toBeUndefined();
  });
});
