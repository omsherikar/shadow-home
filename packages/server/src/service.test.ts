import { join } from 'node:path';
import type { Home, PlanAction } from '@shadow-home/twin';
import { loadHome } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { manualClock } from './clock.ts';
import { initialState } from './live-home.ts';
import { ShadowHomeService } from './service.ts';
import { memoryStore } from './store.ts';

const fixture = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const t = (local: string) => Date.parse(`${local}-06:00`);

function setup(now: string, home: Home = fixture) {
  const clock = manualClock(t(now), Date.parse('2026-10-16T12:00:00Z'));
  const service = new ShadowHomeService({
    store: memoryStore(initialState(home)),
    clock,
    secret: 'unit',
  });
  return { clock, service };
}

const deviceState = async (s: ShadowHomeService, id: string) =>
  (await s.getHomeState({})).devices.find((d) => d.id === id)?.state;

describe('times in a preview', () => {
  test('a time without an offset is rejected, not read in the server time zone', async () => {
    const { service } = setup('2027-01-15T17:45:00');
    await expect(
      service.previewPlan({
        intent: 'away until Sunday',
        actions: [{ device: 'plug_tv', set: { onOff: false } }],
        presenceSchedule: [
          { from: '2027-01-15T18:00:00-06:00', to: '2027-01-17T18:00:00', presence: 'nobody' },
        ],
      }),
    ).rejects.toThrow();
  });
});

describe('a yes counts only for the question it answered', () => {
  const unlockAndFreezer = {
    intent: 'unlock the back door and switch off the freezer',
    requestedBy: 'om',
    actions: [
      { device: 'back_door_lock', set: { lockState: 'UNLOCKED' } },
      { device: 'plug_garage_freezer', set: { onOff: false } },
    ] as PlanAction[],
  };

  test('a yes to "do it with the fix?" does not commit the safe part without its own question', async () => {
    const { service } = setup('2027-01-15T21:30:00');
    const p = await service.previewPlan(unlockAndFreezer);
    expect(p.tier).toBe('T3');
    expect(p.speech.ask).toBe('Do it with one fix instead? That leaves Back door lock unlocked.');
    const c = await service.commitPlan({ planId: p.planId, safePartOnly: true, confirmed: true });
    expect(c).toMatchObject({
      status: 'needs_confirmation',
      planId: p.safePart?.planId,
      speech: { ask: 'Back door lock unlocked?' },
    });
    expect((await deviceState(service, 'back_door_lock'))?.lockState).toBe('LOCKED');
  });

  test('the repair, offered with its consequence, commits on that yes', async () => {
    const { service } = setup('2027-01-15T21:30:00');
    const p = await service.previewPlan(unlockAndFreezer);
    const repairId = p.repair?.planId ?? '';
    expect((await service.commitPlan({ planId: repairId })).status).toBe('needs_confirmation');
    const c = await service.commitPlan({ planId: repairId, confirmed: true });
    expect(c.status).toBe('committed');
    expect((await deviceState(service, 'back_door_lock'))?.lockState).toBe('UNLOCKED');
    expect((await deviceState(service, 'plug_garage_freezer'))?.onOff).toBe(true);
  });
});

describe('an alternative is not what was asked for', () => {
  test('a SAFE repair still waits for a yes, then commits on it', async () => {
    const { service } = setup('2027-01-15T21:30:00');
    const p = await service.previewPlan({
      intent: 'freezer and TV off',
      requestedBy: 'om',
      actions: [
        { device: 'plug_garage_freezer', set: { onOff: false } },
        { device: 'plug_tv', set: { onOff: false } },
      ],
    });
    expect(p).toMatchObject({ verdict: 'UNSAFE', tier: 'T3', repair: { verdict: 'SAFE' } });
    const repairId = p.repair?.planId ?? '';
    const asked = await service.commitPlan({ planId: repairId });
    expect(asked).toMatchObject({ status: 'needs_confirmation', planId: repairId });
    expect(asked.speech.ask).toBeTruthy();
    expect((await deviceState(service, 'plug_tv'))?.onOff).toBe(true);
    expect((await service.commitPlan({ planId: repairId, confirmed: true })).status).toBe(
      'committed',
    );
  });
});

describe('a yes to an offered alternative is not a yes to the plan', () => {
  const dishwasherAndTv = {
    intent: 'dishwasher at 2 and the TV off',
    requestedBy: 'om',
    actions: [
      { device: 'dishwasher', set: { onOff: true }, at: '2027-01-16T02:00:00-06:00' },
      { device: 'plug_tv', set: { onOff: false } },
    ] as PlanAction[],
  };

  test('"Do just the part I can confirm?" then a yes on the whole plan asks "Run it anyway?" first', async () => {
    const { service } = setup('2027-01-15T21:30:00');
    const p = await service.previewPlan(dishwasherAndTv);
    expect(p).toMatchObject({ verdict: 'UNPROVEN', tier: 'T4' });
    expect(p.speech.ask).toBe('Do just the part I can confirm?');

    const first = await service.commitPlan({ planId: p.planId, confirmed: true });
    expect(first).toMatchObject({
      status: 'needs_confirmation',
      planId: p.planId,
      speech: { ask: 'Run it anyway?' },
    });
    expect((await service.getHomeState({})).scheduled).toEqual([]);

    // Now the question was about this plan, so a yes commits it.
    const second = await service.commitPlan({ planId: p.planId, confirmed: true });
    expect(second.status).toBe('committed');
    expect(second.held.map((c) => c.target)).toEqual(['dishwasher']);
  });

  test('a tap on screen approves the plan it is on, whatever the question offered', async () => {
    const { service } = setup('2027-01-15T21:30:00');
    const p = await service.previewPlan(dishwasherAndTv);
    await service.approvePlan({ planId: p.planId, approvalToken: service.approvalToken(p.planId) });
    expect((await service.commitPlan({ planId: p.planId })).status).toBe('committed');
  });
});

describe('undo', () => {
  test('a stale undo is worked out again: a write that fired since is put back, not cancelled', async () => {
    const { clock, service } = setup('2027-01-15T21:30:00');
    const p = await service.previewPlan({
      intent: 'dishwasher at 2',
      requestedBy: 'om',
      actions: [{ device: 'dishwasher', set: { onOff: true }, at: '2027-01-16T02:00:00-06:00' }],
    });
    expect((await service.commitPlan({ planId: p.planId, confirmed: true })).status).toBe(
      'committed',
    );
    clock.setHomeNow(t('2027-01-16T01:59:40'));
    const u = await service.undo({ token: 'last' });
    expect(u.notes[0]).toMatch(/^Cancels dishwasher/);
    expect(u.preview?.diff).toEqual([]);

    clock.setHomeNow(t('2027-01-16T02:00:10'));
    const late = await service.commitPlan({ planId: u.preview?.planId ?? '', confirmed: true });
    expect(late).toMatchObject({ status: 'refused', reason: 'state_changed' });
    expect(late.freshPreview?.diff.map((r) => `${r.target} ${r.from}→${r.to}`)).toEqual([
      'dishwasher true→false',
    ]);
    const c = await service.commitPlan({
      planId: late.freshPreview?.planId ?? '',
      confirmed: true,
    });
    expect(c.status).toBe('committed');
    expect((await deviceState(service, 'dishwasher'))?.onOff).toBe(false);
  });

  test('a routine paused twice by one plan resumes, rather than going back to the first pause', async () => {
    const { service } = setup('2027-01-15T17:45:00');
    const p = await service.previewPlan({
      intent: 'pause coffee',
      requestedBy: 'om',
      actions: [
        { routine: 'coffee_at_7', pauseUntil: '2027-01-16T09:00:00-06:00' },
        { routine: 'coffee_at_7', pauseUntil: '2027-01-17T18:00:00-06:00' },
      ],
    });
    expect((await service.commitPlan({ planId: p.planId, confirmed: true })).status).toBe(
      'committed',
    );
    const u = await service.undo({ token: 'last' });
    expect(u.notes).toContain('Coffee at 7 resumes.');
    await service.commitPlan({ planId: u.preview?.planId ?? '', confirmed: true });
    const routines = (await service.getHomeState({})).routines;
    expect(routines.find((r) => r.id === 'coffee_at_7')?.pausedUntil).toBeUndefined();
  });

  test('a scheduled write to an irreversible attribute is listed as such once it has run', async () => {
    const home = structuredClone(fixture);
    const dishwasher = home.devices.find((d) => d.id === 'dishwasher');
    const latch = home.devices.find((d) => d.id === 'dishwasher_latch');
    if (dishwasher) dishwasher.irreversible = ['onOff'];
    if (latch?.sensor) latch.sensor.batteryPercent = 80;
    const { clock, service } = setup('2027-01-15T21:30:00', home);
    const p = await service.previewPlan({
      intent: 'dishwasher at 2',
      requestedBy: 'om',
      actions: [{ device: 'dishwasher', set: { onOff: true }, at: '2027-01-16T02:00:00-06:00' }],
    });
    expect(p).toMatchObject({ verdict: 'SAFE', tier: 'T2' });
    await service.commitPlan({ planId: p.planId, confirmed: true });
    clock.setHomeNow(t('2027-01-16T02:05:00'));
    const u = await service.undo({ token: 'last' });
    expect(u.status).toBe('nothing_to_undo');
    expect(u.cannotUndo).toEqual([
      { target: 'dishwasher', attr: 'onOff', why: "it can't be undone once it has run" },
    ]);
  });

  test('a scheduled mode change is held, and an undo before it happens cancels it', async () => {
    const { clock, service } = setup('2027-01-15T17:45:00');
    const p = await service.previewPlan({
      intent: 'away mode at 7',
      requestedBy: 'om',
      actions: [{ mode: 'away', at: '2027-01-15T19:00:00-06:00' }],
    });
    const c = await service.commitPlan({ planId: p.planId, confirmed: true });
    expect(c.held).toEqual([{ target: 'home', attr: 'mode', from: 'home', to: 'away' }]);
    const u = await service.undo({ token: 'last' });
    expect(u.notes).toEqual(['Cancels the change to away mode at 2027-01-15T19:00:00-06:00.']);
    await service.commitPlan({ planId: u.preview?.planId ?? '', confirmed: true });
    clock.setHomeNow(t('2027-01-15T19:30:00'));
    expect((await service.getHomeState({})).mode).toBe('home');
  });
});

describe('the live home and the engine agree about now', () => {
  test("a preview at the start of a minute doesn't run that minute's routine steps again", async () => {
    // At 22:30 Good night locks the back door, then a held unlock opens it: it is unlocked.
    const { clock, service } = setup('2027-01-15T22:00:00');
    const unlock = await service.previewPlan({
      intent: 'unlock the back door at 22:30',
      requestedBy: 'om',
      actions: [
        {
          device: 'back_door_lock',
          set: { lockState: 'UNLOCKED' },
          at: '2027-01-15T22:30:00-06:00',
        },
      ],
    });
    await service.commitPlan({ planId: unlock.planId, confirmed: true });
    clock.setHomeNow(t('2027-01-15T22:30:00'));
    expect((await deviceState(service, 'back_door_lock'))?.lockState).toBe('UNLOCKED');

    const leaving = await service.previewPlan({
      intent: 'we are heading out',
      requestedBy: 'om',
      actions: [{ device: 'plug_tv', set: { onOff: false } }],
      presenceSchedule: [
        { from: '2027-01-15T22:31:00-06:00', to: '2027-01-15T23:30:00-06:00', presence: 'nobody' },
      ],
    });
    expect(leaving.verdict).toBe('UNSAFE');
    expect(leaving.violations.map((v) => v.rule)).toContain('R5');
  });

  test('a server idle for longer than one sync step catches up fully before checking', async () => {
    const { clock, service } = setup('2027-01-15T17:45:00');
    clock.setHomeNow(t('2027-01-25T08:00:00'));
    const state = await service.getHomeState({});
    expect(state.now).toBe('2027-01-25T08:00:01-06:00');
  });
});

describe('words people typed', () => {
  test('a request is stored without control characters, its runs of spaces made one', async () => {
    const { service } = setup('2027-01-15T17:45:00');
    const p = await service.previewPlan({
      intent: 'TV\u0000 off,\r\n\tplease\u001b[2J\u009b  now\u007f',
      requestedBy: 'om',
      actions: [{ device: 'plug_tv', set: { onOff: false } }],
    });
    expect((await service.commitPlan({ planId: p.planId })).status).toBe('committed');
    const log = await service.getActivityLog({ groupBy: 'none' });
    expect(log.entries.find((e) => e.source === 'plan')?.what).toBe('TV off, please[2J now');
  });
});
