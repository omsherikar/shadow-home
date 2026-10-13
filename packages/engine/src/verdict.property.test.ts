import { join } from 'node:path';
import { type Capability, own, type Plan, type PlanAction, type Value } from '@shadow-home/twin';
import { loadHome } from '@shadow-home/twin/node';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { ruleDevices } from './rules.ts';
import { formatIso, toMs } from './time.ts';
import { check } from './verdict.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const NOW_MS = toMs('2027-01-15T17:45:00-06:00');
const iso = (minutesFromNow: number) => formatIso(NOW_MS + minutesFromNow * 60_000, -360);

const valueFor = (cap: Capability): fc.Arbitrary<Value> => {
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
const when = fc.option(fc.integer({ min: 0, max: 18 * 60 }).map(iso), { nil: undefined });

const action: fc.Arbitrary<PlanAction> = fc.oneof(
  fc
    .constantFrom(...writable)
    .chain((d) =>
      fc.tuple(
        fc.constant(d.id),
        fc
          .constantFrom(...Object.entries(d.capabilities))
          .chain(([attr, cap]) => valueFor(cap).map((v) => ({ [attr]: v }))),
        when,
      ),
    )
    .map(([device, set, at]) => (at ? { device, set, at } : { device, set })),
  fc
    .tuple(
      fc.constantFrom(...home.routines.map((r) => r.id)),
      fc.integer({ min: 60, max: 18 * 60 }),
    )
    .map(([routine, m]) => ({ routine, pauseUntil: iso(m) })),
);

const plan: fc.Arbitrary<Plan> = fc
  .tuple(
    fc.array(action, { maxLength: 4 }),
    fc.option(fc.integer({ min: 15, max: 12 * 60 }), { nil: undefined }),
  )
  .map(([actions, awayMinutes]) => ({
    context: {
      now: iso(0),
      ...(awayMinutes === undefined
        ? {}
        : {
            // Start from a home that is fine with nobody in it, so SAFE plans with an away
            // window exist and the presence rules (R4, R5, R7, R8, R10) get exercised.
            stateOverrides: {
              front_door_lock: { state: { lockState: 'LOCKED' } },
              light_living: { state: { onOff: false } },
              light_kitchen: { state: { onOff: false } },
              light_bedroom_sam: { state: { onOff: false } },
            },
            presenceSchedule: [
              { from: iso(15), to: iso(15 + awayMinutes), presence: 'nobody' as const },
            ],
          }),
    },
    actions,
  }));

// Each property runs dozens of full three-run checks: about 3 s alone, several times that on a
// loaded machine or a CI runner, so the 5 s default would time out.
describe('verdict properties', { timeout: 60_000 }, () => {
  test('the same plan always gets the same result', () => {
    fc.assert(
      fc.property(plan, (p) => {
        expect(check(home, structuredClone(p))).toEqual(check(home, p));
      }),
      { numRuns: 25 },
    );
  });

  test('a plan with no actions is SAFE when the starting state breaks no rule', () => {
    // Everyone is home and every device is as the fixture has it. Any `now` whose 12-hour
    // horizon fits in the forecast (Fri 17:00 to Sun 12:00).
    fc.assert(
      fc.property(fc.integer({ min: -45, max: 42 * 60 + 15 }), (m) => {
        const r = check(home, { context: { now: iso(m) }, actions: [] });
        expect(r.verdict).toBe('SAFE');
      }),
      { numRuns: 20 },
    );
  });

  test('a plan that fails lint is UNSAFE and is never simulated', () => {
    fc.assert(
      fc.property(plan, fc.constantFrom('sauna', 'garage_door'), (p, device) => {
        const bad: Plan = { ...p, actions: [...p.actions, { device, set: { onOff: true } }] };
        const r = check(home, bad);
        expect(r.verdict).toBe('UNSAFE');
        expect(r.runs).toBeUndefined();
      }),
      { numRuns: 25 },
    );
  });

  test('removing an action never makes a SAFE plan UNSAFE unless that action was preventing the violation', () => {
    let safeWithAwayWindow = 0;
    fc.assert(
      fc.property(
        plan.filter((p) => p.actions.length > 0 && check(home, p).verdict === 'SAFE'),
        (p) => {
          if (p.context.presenceSchedule) safeWithAwayWindow++;
          p.actions.forEach((removed, i) => {
            const reduced = { ...p, actions: p.actions.filter((_, j) => j !== i) };
            const r = check(home, reduced);
            if (r.verdict !== 'UNSAFE') return;
            const explained = r.reasons.some((reason) => {
              if (reason.kind !== 'violation') return false;
              const rule = home.rules.find((x) => x.id === reason.rule);
              if ('device' in removed && rule) {
                if (ruleDevices(home, rule).includes(removed.device)) return true;
              }
              return 'routine' in removed && reason.cause?.source === removed.routine;
            });
            expect(explained, `removing action ${i} broke ${JSON.stringify(r.reasons)}`).toBe(true);
          });
        },
      ),
      { numRuns: 12 },
    );
    expect(safeWithAwayWindow, 'no SAFE plan with an away window was generated').toBeGreaterThan(0);
  });

  test('checking a plan never changes the home', () => {
    const before = JSON.stringify(home);
    fc.assert(
      fc.property(plan, (p) => {
        check(home, p);
      }),
      { numRuns: 10 },
    );
    expect(JSON.stringify(home)).toBe(before);
    expect(own(home.groups, 'all_plugs')).toHaveLength(5);
  });
});
