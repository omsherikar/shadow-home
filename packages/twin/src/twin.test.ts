import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CLUSTERS, findClusterAttr } from './clusters.ts';
import { loadHome } from './node.ts';
import { hasOwn, own } from './records.ts';
import {
  type Capability,
  type Home,
  homeSchema,
  planActionSchema,
  planSchema,
  presenceSpecSchema,
  type Value,
} from './schema.ts';
import { validateHome } from './validate.ts';
import { attrDomain, checkValue } from './values.ts';

const root = join(import.meta.dirname, '../../..');
const fixture = join(root, 'fixtures/demo-home.json');
const home = loadHome(fixture);

/** A deep copy of the demo home to break on purpose. */
function broken(edit: (h: Home) => void): Home {
  const copy = structuredClone(home);
  edit(copy);
  return copy;
}

function device(h: Home, id: string) {
  const d = h.devices.find((x) => x.id === id);
  if (!d) throw new Error(`no device ${id}`);
  return d;
}

describe('demo home fixture', () => {
  test('parses and has no cross-reference problems', () => {
    expect(validateHome(home)).toEqual([]);
  });

  test('matches the counts in fixtures/README.md', () => {
    expect(home.rooms).toHaveLength(5);
    expect(home.devices).toHaveLength(21);
    expect(home.routines).toHaveLength(3);
    expect(home.rules).toHaveLength(12);
    expect(home.forecast.hourly).toHaveLength(80);
  });

  test('all_plugs sweeps in the freezer and the aquarium (the demo trap)', () => {
    expect(home.groups.all_plugs).toEqual(
      expect.arrayContaining(['plug_garage_freezer', 'plug_aquarium']),
    );
  });
});

describe('validateHome catches broken references', () => {
  test.each<[string, (h: Home) => void, RegExp]>([
    [
      'unknown room',
      (h) => {
        device(h, 'plug_tv').room = 'attic';
      },
      /unknown room attic/,
    ],
    [
      'capability outside its clusters',
      (h) => {
        device(h, 'light_kitchen').capabilities.brightness = {
          type: 'number',
          min: 0,
          max: 100,
          step: 1,
        };
      },
      /light_kitchen capability brightness isn't in any of its clusters/,
    ],
    [
      'read-only attribute offered as a capability',
      (h) => {
        device(h, 'window_bedroom_main').capabilities.contact = {
          type: 'enum',
          values: ['open', 'closed'],
        };
      },
      /capability contact is read-only in BooleanState/,
    ],
    [
      'unmodelled cluster',
      (h) => void device(h, 'plug_tv').matter.clusters.push('ColorControl'),
      /unmodelled cluster ColorControl/,
    ],
    [
      'Alexa interface no attribute uses',
      (h) => void device(h, 'plug_tv').alexa.interfaces.push('Alexa.LockController'),
      /lists Alexa interface Alexa.LockController/,
    ],
    [
      'group member that does not exist',
      (h) => void h.groups.all_plugs?.push('plug_sauna'),
      /group all_plugs includes unknown device plug_sauna/,
    ],
    [
      'routine value out of range',
      (h) => {
        const a = h.routines[0]?.actions[0];
        if (a) a.set = { lockState: 'JAMMED' };
      },
      /routine good_night action 0 front_door_lock.lockState: expected one of LOCKED, UNLOCKED/,
    ],
    [
      'rule on an unknown device',
      (h) => {
        const r = h.rules.find((x) => x.id === 'R1');
        if (r?.template === 'always') r.params.state.device = 'chest_freezer';
      },
      /rule R1 refers to unknown device chest_freezer/,
    ],
    [
      'rule on an unknown member',
      (h) => {
        const r = h.rules.find((x) => x.id === 'R4');
        if (r?.template === 'never_when')
          r.params.when = { presence: { member: 'zoe', is: 'home' } };
      },
      /rule R4 refers to unknown member zoe/,
    ],
    [
      'duplicate device id',
      (h) => void h.devices.push(structuredClone(device(h, 'plug_tv'))),
      /duplicate device id plug_tv/,
    ],
    [
      'heater thermostat that controls another zone',
      (h) => {
        device(h, 'garage_thermostat').controlsZone = 'house';
      },
      /zone garage heater thermostat garage_thermostat doesn't control it/,
    ],
    [
      'forecast out of order',
      (h) => h.forecast.hourly.reverse(),
      /forecast time .* is not after the one before/,
    ],
    [
      'a utcOffset that disagrees with the clock',
      (h) => {
        h.home.utcOffset = '+00:00';
      },
      /clock.now offset -06:00 doesn't match the home's utcOffset \+00:00/,
    ],
    [
      'a rule comparing a read-only attribute to an impossible value',
      (h) => {
        const r = h.rules.find((x) => x.id === 'R9');
        if (r?.template === 'never_together') {
          r.params.b = { device: 'window_bedroom_main', attr: 'contact', eq: 'Open' };
        }
      },
      /rule R9 compares window_bedroom_main.contact: expected one of open, closed, got "Open"/,
    ],
    [
      'a read-only state value outside its domain',
      (h) => {
        device(h, 'back_door_contact').state.contact = 'ajar';
      },
      /back_door_contact state contact: expected one of open, closed/,
    ],
    [
      'a group listing a device twice',
      (h) => void h.groups.all_plugs?.push('plug_tv'),
      /group all_plugs lists plug_tv twice/,
    ],
    [
      'a capability whose min is above its max',
      (h) => {
        device(h, 'thermostat_main').capabilities.heatingSetpointC = {
          type: 'number',
          min: 30,
          max: 7,
          step: 0.5,
        };
      },
      /thermostat_main capability heatingSetpointC has min 30 above max 7/,
    ],
    [
      'a keep_between rule whose min is above its max',
      (h) => {
        const r = h.rules.find((x) => x.id === 'R3');
        if (r?.template === 'keep_between') r.params.max = 2;
      },
      /rule R3 has min 4 above max 2/,
    ],
    [
      'a capability with no current state',
      (h) => {
        delete device(h, 'light_living').state.brightness;
      },
      /light_living has no state for its capability brightness/,
    ],
    [
      'a household member with no presence',
      (h) => {
        delete h.household.presence.sam;
      },
      /member sam has no presence/,
    ],
    [
      'a scheduled write to a device that does not exist',
      (h) => {
        h.scheduled = [
          { device: 'sauna', set: { onOff: true }, at: '2027-01-16T02:00:00-06:00', source: 'p' },
        ];
      },
      /scheduled 0 uses unknown device sauna/,
    ],
    [
      'a scheduled write out of range',
      (h) => {
        h.scheduled = [
          {
            device: 'thermostat_main',
            set: { heatingSetpointC: 45 },
            at: '2027-01-16T02:00:00-06:00',
            source: 'p',
          },
        ];
      },
      /scheduled 0 thermostat_main.heatingSetpointC/,
    ],
    [
      'an irreversible attribute that is not a capability',
      (h) => {
        device(h, 'dishwasher').irreversible = ['contact'];
      },
      /dishwasher marks contact irreversible, but it isn't a capability/,
    ],
  ])('%s', (_name, edit, expected) => {
    const problems = validateHome(broken(edit));
    expect(problems.join('\n')).toMatch(expected);
  });
});

describe('checkValue', () => {
  const setpoint: Capability = { type: 'number', min: 7, max: 30, step: 0.5 };
  const onOff: Capability = { type: 'boolean' };
  const lock: Capability = { type: 'enum', values: ['LOCKED', 'UNLOCKED'] };
  test.each<[Capability, Value, string | null]>([
    [setpoint, 21, null],
    [setpoint, 21.5, null],
    [setpoint, 7, null],
    [setpoint, 30, null],
    [setpoint, 45, 'out_of_range'],
    [setpoint, 6.5, 'out_of_range'],
    [setpoint, 21.3, 'off_step'],
    [setpoint, '21', 'wrong_type'],
    [setpoint, Number.NaN, 'wrong_type'],
    [onOff, true, null],
    [onOff, 'on', 'wrong_type'],
    [lock, 'LOCKED', null],
    [lock, 'locked', 'not_in_enum'],
  ])('%o with %o gives %s', (cap, value, code) => {
    expect(checkValue(cap, value)?.code ?? null).toBe(code);
  });
});

describe('clusters', () => {
  test('every attribute name maps to one cluster', () => {
    const names = Object.values(CLUSTERS).flatMap((c) => c.attrs.map((a) => a.name));
    expect(new Set(names).size).toBe(names.length);
  });

  test('findClusterAttr looks only in the given clusters', () => {
    expect(findClusterAttr(['OnOff'], 'onOff')?.alexa).toBe('Alexa.PowerController');
    expect(findClusterAttr(['OnOff'], 'brightness')).toBeUndefined();
  });
});

describe('plan schema', () => {
  const planDir = join(root, 'bench/plans');
  const long = 'x'.repeat(101);
  const attrs = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}`, true]));
  const files = readdirSync(planDir).filter((f) => f.endsWith('.json'));

  test.each(files)('bench plan %s parses', (file) => {
    expect(() =>
      planSchema.parse(JSON.parse(readFileSync(join(planDir, file), 'utf8'))),
    ).not.toThrow();
  });

  test('demo-script draft plans parse', () => {
    const script = JSON.parse(readFileSync(join(root, 'fixtures/demo-script.json'), 'utf8'));
    for (const beat of script.beats) {
      for (const action of beat.draftPlanExample ?? []) {
        expect(() => planActionSchema.parse(action)).not.toThrow();
      }
    }
  });

  test.each([
    ['device and group together', { device: 'plug_tv', group: 'all_plugs', set: { onOff: false } }],
    ['an empty set', { device: 'plug_tv', set: {} }],
    [
      'a time without an offset',
      { device: 'plug_tv', set: { onOff: false }, at: '2027-01-15T18:00:00' },
    ],
    ['a routine without pauseUntil', { routine: 'coffee_at_7' }],
    ['an unknown key', { device: 'plug_tv', set: { onOff: false }, when: 'later' }],
    ['a device ID past 100 characters', { device: long, set: { onOff: false } }],
    ['a group past 100 characters', { group: long, set: { onOff: false } }],
    ['a routine past 100 characters', { routine: long, pauseUntil: '2027-01-16T08:00:00-06:00' }],
    ['an attribute past 100 characters', { device: 'plug_tv', set: { [long]: false } }],
    ['a value past 100 characters', { device: 'front_door_lock', set: { lockState: long } }],
    ['a mode past 100 characters', { mode: long }],
    ['more than 20 attributes', { device: 'plug_tv', set: attrs(21) }],
  ])('rejects an action with %s', (_name, action) => {
    expect(planActionSchema.safeParse(action).success).toBe(false);
  });

  test('names and values up to 100 characters, 20 attributes and 20 people home are accepted', () => {
    const name = 'x'.repeat(100);
    for (const action of [
      { device: name, set: { [name]: name } },
      { group: name, set: attrs(20) },
      { routine: name, pauseUntil: '2027-01-16T08:00:00-06:00' },
      { mode: name },
    ]) {
      expect(planActionSchema.safeParse(action).success).toBe(true);
    }
    expect(presenceSpecSchema.safeParse({ home: Array(20).fill(name) }).success).toBe(true);
    expect(presenceSpecSchema.safeParse({ home: Array(21).fill('om') }).success).toBe(false);
    expect(presenceSpecSchema.safeParse({ home: [long] }).success).toBe(false);
  });
});

describe('own and hasOwn', () => {
  const record: Record<string, number> = { a: 1 };
  test('see own keys only', () => {
    expect(own(record, 'a')).toBe(1);
    expect(own(record, 'toString')).toBeUndefined();
    expect(own(record, 'constructor')).toBeUndefined();
    expect(hasOwn(record, 'a')).toBe(true);
    expect(hasOwn(record, 'hasOwnProperty')).toBe(false);
  });
});

describe('home schema', () => {
  test.each(['-6:00', 'UTC-6', '-0600', 'Z'])('rejects utcOffset %s', (utcOffset) => {
    const raw = structuredClone(home);
    raw.home.utcOffset = utcOffset;
    expect(homeSchema.safeParse(raw).success).toBe(false);
  });
});

describe('attrDomain', () => {
  test('uses the capability for writable attributes and the cluster for read-only ones', () => {
    expect(attrDomain(device(home, 'thermostat_main'), 'heatingSetpointC')).toMatchObject({
      type: 'number',
      min: 7,
    });
    expect(attrDomain(device(home, 'window_bedroom_main'), 'contact')).toEqual({
      type: 'enum',
      values: ['open', 'closed'],
    });
    expect(attrDomain(device(home, 'occupancy_living'), 'occupied')).toEqual({ type: 'boolean' });
    expect(attrDomain(device(home, 'plug_tv'), 'contact')).toBeUndefined();
    expect(attrDomain(device(home, 'plug_tv'), 'toString')).toBeUndefined();
  });
});
