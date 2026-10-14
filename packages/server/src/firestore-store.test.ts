// The Firestore store against the Firestore emulator. Runs when FIRESTORE_EMULATOR_HOST is set:
//   docker run --rm -p 127.0.0.1:8080:8080 gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
//     gcloud emulators firestore start --host-port=0.0.0.0:8080
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx vitest run packages/server/src/firestore-store.test.ts
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Firestore } from '@google-cloud/firestore';
import { loadHome } from '@shadow-home/twin/node';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { manualClock } from './clock.ts';
import { firestoreStore } from './firestore-store.ts';
import { initialState } from './live-home.ts';
import { ShadowHomeService } from './service.ts';
import type { LiveState, LogEntry, Store } from './store.ts';
import { queueMany } from './test-helpers.ts';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const collection = `homes-test-${randomUUID().slice(0, 8)}`;
// Off Google Cloud there's no metadata server; looking for one first costs seconds.
process.env.METADATA_SERVER_DETECTION ??= 'none';
const db = new Firestore({ projectId: 'shadow-home-test' });

const storeFor = (key: string) =>
  firestoreStore({ db, collection, homeKey: () => key, initial: () => initialState(home) });

const entry = (id: string, what: string): LogEntry => ({
  id,
  at: '2027-01-15T18:00:00-06:00',
  who: 'om',
  source: 'plan',
  what,
  changes: [],
});

afterAll(async () => {
  await db.terminate();
});

describe.skipIf(!emulator)('the Firestore store', () => {
  // The first call opens the connection; give it longer than a test gets.
  beforeAll(async () => {
    await db.collection(collection).doc('warm-up').get();
  }, 30_000);

  test('a new home starts from the fixture, and what a call saves is there for the next', async () => {
    const store = storeFor(`home-${randomUUID()}`);
    expect((await store.loadState()).version).toBe(1);
    await store.atomically(async () => {
      const s = await store.loadState();
      s.version = 7;
      await store.saveState(s);
      // Read your own writes within the call.
      expect((await store.loadState()).version).toBe(7);
    });
    expect((await store.loadState()).version).toBe(7);
  });

  test('previews, approvals and commit results come back as they were stored', async () => {
    const store = storeFor(`home-${randomUUID()}`);
    const state = initialState(home);
    const preview = {
      nonce: 'n1',
      kind: 'plan' as const,
      plan: { context: { now: home.clock.now }, actions: [] },
      intent: 'nothing',
      stateVersion: state.version,
      verdict: 'SAFE' as const,
      tier: 'T0' as const,
      speech: { headline: 'Safe.' },
      summary: 'nothing',
      irreversible: false,
      related: {},
      offers: null,
    };
    await store.atomically(async () => {
      await store.putPreview(preview);
      await store.putApproval('n1', { at: 5, by: 'screen' });
      await store.putCommit('plan-1', { status: 'committed' });
    });
    expect(await store.getPreview('n1')).toEqual(preview);
    expect(await store.getApproval('n1')).toEqual({ at: 5, by: 'screen' });
    expect(await store.getCommit('plan-1')).toEqual({ status: 'committed' });
    expect(await store.getPreview('missing')).toBeUndefined();
    // An ID with a slash names a document, not a path.
    expect(await store.getCommit('a/b/c')).toBeUndefined();
  });

  test('the log keeps the order entries were first written, even when one is rewritten', async () => {
    const store = storeFor(`home-${randomUUID()}`);
    await store.atomically(async () => {
      await store.putLog(entry('b', 'first'));
      await store.putLog(entry('a', 'second'));
    });
    await store.atomically(async () => {
      await store.putLog(entry('c', 'third'));
      await store.putLog({ ...entry('b', 'first'), undoneBy: 'c' });
      // Within the call, the rewrite shows in place and the new entry at the end.
      expect((await store.listLog()).map((e) => e.id)).toEqual(['b', 'a', 'c']);
    });
    const log = await store.listLog();
    expect(log.map((e) => e.id)).toEqual(['b', 'a', 'c']);
    expect(log[0]?.undoneBy).toBe('c');
  });

  test('homes under different keys are kept apart', async () => {
    const a = storeFor(`home-${randomUUID()}`);
    const b = storeFor(`home-${randomUUID()}`);
    await a.atomically(() => a.putLog(entry('only-in-a', 'x')));
    expect(await b.listLog()).toEqual([]);
  });

  test('a call that throws writes nothing', async () => {
    const store = storeFor(`home-${randomUUID()}`);
    await expect(
      store.atomically(async () => {
        await store.putLog(entry('half', 'x'));
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(await store.listLog()).toEqual([]);
  });

  test('writing outside a call is refused', async () => {
    const store = storeFor(`home-${randomUUID()}`);
    await expect(store.putLog(entry('x', 'x'))).rejects.toThrow('inside atomically');
  });

  test('a call that lost the race runs again on the newer home, so neither change is lost', async () => {
    const key = `home-${randomUUID()}`;
    const a = storeFor(key);
    const b = storeFor(key);
    const bump = async (s: LiveState) => ({ ...s, version: s.version + 1 });
    // The home exists already, so this is an update losing the race (a new home's is below).
    await b.atomically(async () => b.saveState(await b.loadState()));
    let runsOfA = 0;
    let release: () => void = () => {};
    const bWrote = new Promise<void>((r) => {
      release = r;
    });
    const slow = a.atomically(async () => {
      runsOfA++;
      const s = await a.loadState();
      if (runsOfA === 1) await bWrote;
      await a.saveState(await bump(s));
    });
    await b.atomically(async () => b.saveState(await bump(await b.loadState())));
    release();
    await slow;
    expect(runsOfA).toBe(2);
    expect((await a.loadState()).version).toBe(3);
  });

  test('two calls creating a new home at once: one lands, the other runs again', async () => {
    const key = `home-${randomUUID()}`;
    const a = storeFor(key);
    const b = storeFor(key);
    let runsOfA = 0;
    let release: () => void = () => {};
    const bWrote = new Promise<void>((r) => {
      release = r;
    });
    const slow = a.atomically(async () => {
      runsOfA++;
      if (runsOfA === 1) await bWrote;
      await a.putLog(entry(`from-a-${runsOfA}`, 'a'));
    });
    await b.atomically(() => b.putLog(entry('from-b', 'b')));
    release();
    await slow;
    expect(runsOfA).toBe(2);
    expect((await a.listLog()).map((e) => e.id)).toEqual(['from-b', 'from-a-2']);
  });
});

describe.skipIf(!emulator)('two server instances on one database', () => {
  const t = (local: string) => Date.parse(`${local}-06:00`);
  const key = `home-${randomUUID()}`;
  const instance = () =>
    new ShadowHomeService({
      store: storeFor(key),
      clock: manualClock(t('2027-01-15T17:45:00'), Date.parse('2026-10-16T12:00:00Z')),
      secret: 'shared',
    });

  test('a plan previewed on one commits on the other, and undo works from either', async () => {
    const one = instance();
    const two = instance();
    const p = await one.previewPlan({
      intent: 'dim the living room',
      requestedBy: 'om',
      actions: [{ device: 'light_living', set: { brightness: 30 } }],
    });
    expect(p.verdict).toBe('SAFE');
    const c = await two.commitPlan({ planId: p.planId });
    expect(c.status).toBe('committed');
    // A retried commit on the first instance gets the same answer, not a second commit.
    expect((await one.commitPlan({ planId: p.planId })).status).toBe('committed');
    const light = async (s: ShadowHomeService) =>
      (await s.getHomeState({})).devices.find((d) => d.id === 'light_living')?.state;
    expect((await light(one))?.brightness).toBe(30);

    const u = await one.undo({ token: 'last' });
    expect(u.status).toBe('preview');
    const back = await two.commitPlan({ planId: u.preview?.planId ?? '', confirmed: true });
    expect(back.status).toBe('committed');
    expect((await light(one))?.brightness).not.toBe(30);
  });

  test('a commit retried on another instance while the first lands gets the same result', async () => {
    const shared = `home-${randomUUID()}`;
    const inner = storeFor(shared);
    let paused: () => void = () => {};
    const atLookup = new Promise<void>((r) => {
      paused = r;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // The first instance stops right after looking for a stored result, and finds none.
    const gated: Store = {
      ...inner,
      getCommit: async (id) => {
        const found = await inner.getCommit(id);
        paused();
        await gate;
        return found;
      },
    };
    const service = (store: Store) =>
      new ShadowHomeService({
        store,
        clock: manualClock(t('2027-01-15T17:45:00'), Date.parse('2026-10-16T12:00:00Z')),
        secret: 'shared',
      });
    const one = service(gated);
    const two = service(storeFor(shared));
    const p = await two.previewPlan({
      intent: 'dim the living room',
      requestedBy: 'om',
      actions: [{ device: 'light_living', set: { brightness: 30 } }],
    });
    const before = (await two.getHomeState({})).stateVersion;
    const retried = one.commitPlan({ planId: p.planId });
    await atLookup;
    const first = await two.commitPlan({ planId: p.planId });
    release();
    expect(first.status).toBe('committed');
    expect(await retried).toEqual(first);
    expect((await two.getHomeState({})).stateVersion).toBe(before + 1);
  });

  test('more firing than one call logs is logged in steps', async () => {
    const service = new ShadowHomeService({
      store: storeFor(`home-${randomUUID()}`),
      clock: manualClock(t('2027-01-15T17:45:00'), Date.parse('2026-10-16T12:00:00Z')),
      secret: 'shared',
    });
    await queueMany(service);
    const clock = (service as unknown as { clock: { advance(ms: number): void } }).clock;
    clock.advance(3 * 60 * 60_000);
    await service.getHomeState({});
    const log = await service.getActivityLog({ groupBy: 'none' });
    expect(log.entries.filter((e) => e.source === 'scheduled')).toHaveLength(150);
  });

  test('commits racing on two instances both land', async () => {
    const one = instance();
    const two = instance();
    const preview = (s: ShadowHomeService, device: string) =>
      s.previewPlan({
        intent: `${device} off`,
        requestedBy: 'om',
        actions: [{ device, set: { onOff: false } }],
      });
    const [p1, p2] = await Promise.all([preview(one, 'plug_tv'), preview(two, 'light_kitchen')]);
    const before = (await one.getHomeState({})).stateVersion;
    const results = await Promise.all([
      one.commitPlan({ planId: p1.planId }),
      two.commitPlan({ planId: p2.planId }),
    ]);
    // The second to land finds the home changed since its preview and is refused, with a fresh
    // preview to ask about, exactly as on one instance. Nothing is lost or applied twice.
    expect(results.map((r) => r.status).sort()).toEqual(['committed', 'refused']);
    expect(results.find((r) => r.status === 'refused')).toMatchObject({ reason: 'state_changed' });
    expect((await one.getHomeState({})).stateVersion).toBe(before + 1);
    const log = await one.getActivityLog({ groupBy: 'none' });
    expect(new Set(log.entries.map((e) => e.id)).size).toBe(log.entries.length);
  });
});
