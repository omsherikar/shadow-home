import { join } from 'node:path';
import {
  type Capability,
  HOME_MODES,
  type Plan,
  type PlanAction,
  planSchema,
  type Value,
} from '@shadow-home/twin';
import { loadHome } from '@shadow-home/twin/node';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { hygiene } from './hygiene.ts';
import { lint } from './lint.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const NOW_MS = Date.parse('2027-01-15T17:45:00-06:00');
const OFFSET_MS = -6 * 60 * 60_000;

/** An ISO time in the home's -06:00 offset, `minutes` after now. */
function iso(minutes: number): string {
  const local = new Date(NOW_MS + minutes * 60_000 + OFFSET_MS).toISOString().slice(0, 19);
  return `${local}-06:00`;
}

const validValue = (cap: Capability): fc.Arbitrary<Value> => {
  switch (cap.type) {
    case 'boolean':
      return fc.boolean();
    case 'number': {
      const steps = Math.round((cap.max - cap.min) / cap.step);
      return fc.integer({ min: 0, max: steps }).map((k) => cap.min + k * cap.step);
    }
    case 'enum':
      return fc.constantFrom(...cap.values);
  }
};

const writable = home.devices.filter((d) => Object.keys(d.capabilities).length > 0);
const time = fc.option(fc.integer({ min: 0, max: 72 * 60 }).map(iso), { nil: undefined });
const withAt = <T extends object>(action: T, at: string | undefined): T =>
  at === undefined ? action : { ...action, at };

const validDeviceAction: fc.Arbitrary<PlanAction> = fc
  .constantFrom(...writable)
  .chain((d) =>
    fc.tuple(
      fc.constant(d.id),
      fc
        .constantFrom(...Object.entries(d.capabilities))
        .chain(([attr, cap]) => validValue(cap).map((v) => ({ [attr]: v }))),
      time,
    ),
  )
  .map(([device, set, at]) => withAt({ device, set }, at));

// Groups every member of which can take onOff.
const validGroupAction: fc.Arbitrary<PlanAction> = fc
  .tuple(fc.constantFrom('all_plugs', 'all_lights', 'indoor_lights'), fc.boolean(), time)
  .map(([group, on, at]) => withAt({ group, set: { onOff: on } }, at));

const validRoutineAction: fc.Arbitrary<PlanAction> = fc
  .tuple(fc.constantFrom(...home.routines.map((r) => r.id)), fc.integer({ min: 1, max: 72 * 60 }))
  .map(([routine, m]) => ({ routine, pauseUntil: iso(m) }));

const validModeAction: fc.Arbitrary<PlanAction> = fc
  .constantFrom(...HOME_MODES)
  .map((mode) => ({ mode }));

const validAction = fc.oneof(
  validDeviceAction,
  validGroupAction,
  validRoutineAction,
  validModeAction,
);

// Anything the schema accepts: made-up IDs, wrong types, past times, bad modes.
const anyValue: fc.Arbitrary<Value> = fc.oneof(
  fc.boolean(),
  fc.double({ noNaN: true, noDefaultInfinity: true, min: -100, max: 100 }),
  fc.constantFrom('LOCKED', 'UNLOCKED', 'heat', 'off', 'open', ''),
);
const anyId = (known: string[]) =>
  fc.oneof(fc.constantFrom(...known), fc.string({ minLength: 1, maxLength: 8 }));
const anyAttr = fc.constantFrom(
  'onOff',
  'brightness',
  'heatingSetpointC',
  'systemMode',
  'lockState',
  'contact',
  'localTemperatureC',
  'speed',
);
const anyTime = fc.option(fc.integer({ min: -120, max: 72 * 60 }).map(iso), { nil: undefined });
const anySet = fc.dictionary(anyAttr, anyValue, { minKeys: 1, maxKeys: 3 });

const anyAction: fc.Arbitrary<PlanAction> = fc.oneof(
  validAction,
  fc
    .tuple(anyId(home.devices.map((d) => d.id)), anySet, anyTime)
    .map(([device, set, at]) => withAt({ device, set }, at)),
  fc
    .tuple(anyId(Object.keys(home.groups)), anySet, anyTime)
    .map(([group, set, at]) => withAt({ group, set }, at)),
  fc
    .tuple(anyId(home.routines.map((r) => r.id)), fc.integer({ min: -120, max: 72 * 60 }))
    .map(([routine, m]) => ({ routine, pauseUntil: iso(m) })),
  fc.oneof(fc.constantFrom('home', 'away', 'night', 'vacation')).map((mode) => ({ mode })),
);

const toPlan = (actions: PlanAction[]): Plan => ({ context: { now: iso(0) }, actions });
const validPlan = fc.array(validAction, { maxLength: 8 }).map(toPlan);
const anyPlan = fc.array(anyAction, { maxLength: 8 }).map(toPlan);

describe('lint and hygiene properties', () => {
  test('generated plans are schema-valid (the generators test what the server would accept)', () => {
    fc.assert(fc.property(anyPlan, (p) => planSchema.safeParse(p).success));
  });

  test('same input, same output, and the input is never mutated', () => {
    fc.assert(
      fc.property(anyPlan, (p) => {
        const before = JSON.stringify(p);
        const first = [lint(home, p), hygiene(home, p)];
        const second = [lint(home, structuredClone(p)), hygiene(home, structuredClone(p))];
        expect(second).toEqual(first);
        expect(JSON.stringify(p)).toBe(before);
      }),
    );
  });

  test('a plan of valid writes always lints clean', () => {
    fc.assert(
      fc.property(validPlan, (p) => {
        expect(lint(home, p)).toEqual({ ok: true, findings: [] });
      }),
    );
  });

  test('removing an action removes exactly its own lint findings', () => {
    fc.assert(
      fc.property(
        anyPlan.filter((p) => p.actions.length > 0),
        fc.nat(),
        (p, n) => {
          const drop = n % p.actions.length;
          const reduced = { ...p, actions: p.actions.filter((_, i) => i !== drop) };
          const expected = lint(home, p)
            .findings.filter((f) => f.actionIndex !== drop)
            .map((f) =>
              f.actionIndex !== null && f.actionIndex > drop
                ? { ...f, actionIndex: f.actionIndex - 1 }
                : f,
            );
          expect(lint(home, reduced).findings).toEqual(expected);
        },
      ),
    );
  });

  test('hygiene findings point at real actions, in order, and never throw', () => {
    fc.assert(
      fc.property(anyPlan, (p) => {
        const findings = hygiene(home, p);
        const firsts = findings.map((f) => f.actionIndexes[0] ?? -1);
        expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
        for (const f of findings) {
          for (const i of f.actionIndexes) expect(i).toBeLessThan(p.actions.length);
        }
      }),
    );
  });

  test('an empty plan has no findings in either stage', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 72 * 60 }), (m) => {
        const p: Plan = { context: { now: iso(m) }, actions: [] };
        expect(lint(home, p).findings).toEqual([]);
        expect(hygiene(home, p)).toEqual([]);
      }),
    );
  });
});
