import { join } from 'node:path';
import { loadHome } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { createApp } from './app.ts';
import { demoClock, manualClock } from './clock.ts';
import { initialState } from './live-home.ts';
import { ShadowHomeService } from './service.ts';
import { memoryStore } from './store.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const START = Date.parse(home.clock.now);

/** An app with demo controls, and a wall clock the test moves. */
function demoApp() {
  let wall = 1_000_000;
  const clock = demoClock(START, () => wall);
  const service = new ShadowHomeService({
    store: memoryStore(initialState(home)),
    clock,
    secret: 'demo',
  });
  const app = createApp(service, { demo: { clock, home } });
  const post = (path: string, body?: unknown) =>
    app.request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost' },
      body: JSON.stringify(body ?? {}),
    });
  return { app, service, post, tick: (ms: number) => (wall += ms) };
}

describe('demo controls', () => {
  test('a jump to Sunday evening runs the weekend in between, routines and all', async () => {
    const { service, post } = demoApp();
    const res = await post('/demo/clock', { now: '2027-01-17T18:30:00-06:00' });
    expect(await res.json()).toEqual({ homeNow: '2027-01-17T18:30:00-06:00' });
    const state = await service.getHomeState({});
    expect(state.now.startsWith('2027-01-17T18:30')).toBe(true);
    const log = await service.getActivityLog({});
    expect(log.entries.map((e) => e.source)).toContain('routine');
  });

  test('time only moves forward; an earlier time leaves the clock where it is', async () => {
    const { post, tick } = demoApp();
    tick(60_000);
    const res = await post('/demo/clock', { now: '2027-01-15T12:00:00-06:00' });
    expect(await res.json()).toEqual({ homeNow: '2027-01-15T17:46:00-06:00' });
  });

  test('a reset starts the home over: the fixture clock, and nothing in the log', async () => {
    const { service, post } = demoApp();
    await post('/demo/clock', { now: '2027-01-17T18:30:00-06:00' });
    await service.getHomeState({});
    expect((await service.getActivityLog({})).entries.length).toBeGreaterThan(0);

    const res = await post('/demo/reset');
    expect(await res.json()).toEqual({ homeNow: home.clock.now });
    expect((await service.getActivityLog({})).entries).toEqual([]);
    expect((await service.getHomeState({})).mode).toBe(home.mode);
  });

  test('a bad body is refused', async () => {
    const { post } = demoApp();
    expect((await post('/demo/clock', { now: 'Sunday' })).status).toBe(400);
  });

  test('without demo mode there are no demo controls', async () => {
    const service = new ShadowHomeService({
      store: memoryStore(initialState(home)),
      clock: manualClock(START),
      secret: 'x',
    });
    const res = await createApp(service).request('http://localhost/demo/reset', {
      method: 'POST',
      headers: { host: 'localhost' },
    });
    expect(res.status).toBe(404);
  });
});
