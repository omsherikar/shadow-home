import { join } from 'node:path';
import { loadHome } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { manualClock } from './clock.ts';
import { initialState } from './live-home.ts';
import { previewInput } from './schemas.ts';
import { ShadowHomeService } from './service.ts';
import { memoryStore, type Store } from './store.ts';
import { porchSchedule, queueMany } from './test-helpers.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const START = Date.parse(home.clock.now);
const MINUTE = 60_000;

/** Counts the distinct log entries each call writes. */
function counting(base: Store) {
  const perCall: number[] = [];
  let ids = new Set<string>();
  const store: Store = {
    ...base,
    putLog: async (e) => {
      ids.add(e.id);
      await base.putLog(e);
    },
    atomically: async (fn) => {
      ids = new Set();
      const result = await base.atomically(fn);
      perCall.push(ids.size);
      return result;
    },
  };
  return { store, perCall };
}

describe('catching up after a quiet spell', () => {
  test('more firing than one call can log is logged in steps, and nothing is lost', async () => {
    const clock = manualClock(START, Date.parse('2026-10-16T12:00:00Z'));
    const { store, perCall } = counting(memoryStore(initialState(home)));
    const service = new ShadowHomeService({ store, clock, secret: 'unit' });
    await queueMany(service);

    clock.advance(3 * 60 * MINUTE);
    perCall.length = 0;
    await service.getHomeState({});
    expect(perCall.length).toBeGreaterThan(2);
    expect(Math.max(...perCall)).toBeLessThanOrEqual(45);
    const log = await store.listLog();
    expect(log.filter((e) => e.source === 'scheduled')).toHaveLength(150);
  });

  test('a call with little to catch up saves nothing extra', async () => {
    const clock = manualClock(START, Date.parse('2026-10-16T12:00:00Z'));
    const { store, perCall } = counting(memoryStore(initialState(home)));
    const service = new ShadowHomeService({ store, clock, secret: 'unit' });
    clock.advance(20 * MINUTE);
    await service.getHomeState({});
    // One look to see if catching up is needed, then the call itself.
    expect(perCall).toEqual([0, 0]);
  });

  test('a plan holds at most 50 actions', () => {
    const plan = { intent: 'too much', actions: porchSchedule(1, 51) };
    expect(previewInput.safeParse(plan).success).toBe(false);
    expect(previewInput.safeParse({ ...plan, actions: porchSchedule(1, 50) }).success).toBe(true);
  });
});
