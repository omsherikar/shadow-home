import { join } from 'node:path';
import type { PlanAction } from '@shadow-home/twin';
import { loadHome } from '@shadow-home/twin/node';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { manualClock } from './clock.ts';
import { initialState } from './live-home.ts';
import { ShadowHomeService } from './service.ts';
import { memoryStore } from './store.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const NOW = Date.parse('2027-01-15T21:30:00-06:00');

/** Everyday and risky actions; random subsets make plans of every verdict and tier. */
const ACTIONS: PlanAction[] = [
  { device: 'plug_tv', set: { onOff: false } },
  { device: 'light_living', set: { brightness: 30 } },
  { device: 'thermostat_main', set: { heatingSetpointC: 21 } },
  { device: 'plug_garage_freezer', set: { onOff: false } },
  { group: 'all_plugs', set: { onOff: false } },
  { device: 'garage_thermostat', set: { systemMode: 'off' } },
  { device: 'back_door_lock', set: { lockState: 'UNLOCKED' } },
  { device: 'smoke_alarm_kitchen', set: { enabled: false } },
  { device: 'dishwasher', set: { onOff: true }, at: '2027-01-16T02:00:00-06:00' },
  { device: 'plug_bedroom_space_heater', set: { onOff: true } },
  { routine: 'coffee_at_7', pauseUntil: '2027-01-17T18:00:00-06:00' },
  { mode: 'away' },
  { device: 'sauna', set: { onOff: true } },
];

function service() {
  return new ShadowHomeService({
    store: memoryStore(initialState(home)),
    clock: manualClock(NOW),
    secret: 'property',
  });
}

const plans = fc.subarray(ACTIONS, { minLength: 1, maxLength: 4 });
const action = (i: number) => ACTIONS[i] as PlanAction;
// Always run one plan per branch on top of the random ones, so coverage doesn't depend on luck.
const TV_OFF = action(0); // SAFE, T0
const FREEZER_OFF = action(3); // UNSAFE
const DISHWASHER_2AM = action(8); // UNPROVEN, T4

describe('commit properties', { timeout: 60_000 }, () => {
  test('nothing that is not SAFE commits without a yes, and nothing UNSAFE commits at all', async () => {
    const seen = { committedWithYes: 0, committedWithout: 0, unsafe: 0 };
    await fc.assert(
      fc.asyncProperty(plans, fc.boolean(), async (actions, confirmed) => {
        const s = service();
        const p = await s.previewPlan({ intent: 'test', requestedBy: 'om', actions });
        const c = await s.commitPlan({ planId: p.planId, confirmed });
        if (p.verdict === 'UNSAFE') seen.unsafe++;
        if (c.status !== 'committed') return;
        if (confirmed && p.verdict !== 'SAFE') seen.committedWithYes++;
        if (!confirmed) seen.committedWithout++;
        expect(p.verdict).not.toBe('UNSAFE');
        if (!confirmed) {
          expect(p.verdict).toBe('SAFE');
          expect(['T0', 'T1']).toContain(p.tier);
        }
      }),
      {
        numRuns: 40,
        examples: [
          [[TV_OFF], false],
          [[DISHWASHER_2AM], true],
          [[FREEZER_OFF], true],
        ],
      },
    );
    // Each branch was reached, so the property isn't passing vacuously.
    expect(seen.committedWithout).toBeGreaterThan(0);
    expect(seen.committedWithYes).toBeGreaterThan(0);
    expect(seen.unsafe).toBeGreaterThan(0);
  });

  test('the safe part always commits as SAFE, and only its own actions run', async () => {
    let safeParts = 0;
    await fc.assert(
      fc.asyncProperty(plans, async (actions) => {
        const s = service();
        const p = await s.previewPlan({ intent: 'test', requestedBy: 'om', actions });
        if (!p.safePart) return;
        safeParts++;
        expect(p.safePart.verdict).toBe('SAFE');
        const c = await s.commitPlan({ planId: p.planId, safePartOnly: true, confirmed: true });
        expect(c.status).toBe('committed');
        expect(c.planId).toBe(p.safePart.planId);
        const kept = new Set(p.safePart.diff.map((r) => `${r.target}\u0000${r.attr}`));
        for (const change of [...c.applied, ...c.held]) {
          expect(kept.has(`${change.target}\u0000${change.attr}`)).toBe(true);
        }
      }),
      { numRuns: 30, examples: [[[TV_OFF, FREEZER_OFF]]] },
    );
    expect(safeParts).toBeGreaterThan(0);
  });
});
