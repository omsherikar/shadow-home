// Plans shared by the server's tests.
import { join } from 'node:path';
import type { PlanAction } from '@shadow-home/twin';
import { loadHome } from '@shadow-home/twin/node';
import { expect } from 'vitest';
import type { ShadowHomeService } from './service.ts';
import { isoAt } from './time.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const START = Date.parse(home.clock.now);
const MINUTE = 60_000;

/** Porch light changes, one a minute, from `first` minutes on: each is its own logged event. */
export function porchSchedule(first: number, count: number): PlanAction[] {
  return Array.from({ length: count }, (_, i) => ({
    device: 'light_porch',
    // Off first: the porch light is already on, and a write that changes nothing isn't logged.
    set: { onOff: i % 2 === 1 },
    at: isoAt(START + (first + i) * MINUTE, home.home.utcOffset),
  }));
}

/** Queue 150 porch-light changes over the next two and a half hours, 50 a plan. */
export async function queueMany(service: ShadowHomeService) {
  for (const first of [1, 51, 101]) {
    const p = await service.previewPlan({
      intent: 'porch light show',
      requestedBy: 'om',
      actions: porchSchedule(first, 50),
    });
    expect(p.verdict).toBe('SAFE');
    expect((await service.commitPlan({ planId: p.planId })).status).toBe('committed');
  }
}
