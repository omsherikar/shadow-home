import { describe, expect, test } from 'vitest';
import type { LiveDevice } from './looks.ts';
import { type Run, runsFrom } from './playback.ts';
import { markersOf } from './timeline.ts';

const at = (local: string) => Date.parse(`${local}-06:00`);
const FRI = '2027-01-15T17:53:00-06:00';
const SUN = '2027-01-17T18:00:00-06:00';
const entry = (local: string, source: string, device: string, to: boolean) => ({
  at: `${local}-06:00`,
  source,
  device,
  attr: 'onOff',
  from: !to,
  to,
});
const preview = {
  planId: 'plan',
  verdict: 'UNSAFE',
  timeline: [
    entry('2027-01-15T17:53:00', 'plan', 'plug_garage_freezer', false),
    entry('2027-01-16T07:00:00', 'coffee_at_7', 'plug_coffee_maker', true),
  ],
  violations: [
    {
      rule: 'R3',
      text: 'Don’t let the garage pipes freeze.',
      author: 'om',
      run: 'nominal',
      firstAt: '2027-01-16T22:37:00-06:00',
      cause: { device: 'garage_thermostat' },
    },
  ],
  unknowns: [],
  horizon: { start: FRI, end: SUN },
  repair: null,
};
const meta = {
  'shadow-home/replay': {
    plan: { presence: [{ from: '2027-01-15T18:00:00-06:00', to: SUN, presence: 'nobody' }] },
  },
};
const [run] = runsFrom('preview_plan', preview, meta) as [Run];
const devices: LiveDevice[] = [
  { id: 'plug_garage_freezer', name: 'Garage freezer', kind: 'plug', state: { onOff: true } },
  { id: 'plug_coffee_maker', name: 'Coffee maker', kind: 'plug', state: { onOff: false } },
];
const household = { om: 'home', maya: 'home', sam: 'home' } as const;

describe('the timeline’s marks', () => {
  test('one for the plan acting, the household leaving and coming back, each routine and each rule broken, in time order', () => {
    const marks = markersOf(run, devices, household);
    expect(marks.map((m) => [m.kind, m.atMs, m.label])).toEqual([
      ['plan', at('2027-01-15T17:53:00'), 'Garage freezer off'],
      ['leaves', at('2027-01-15T18:00:00'), '3 people leave'],
      ['routine', at('2027-01-16T07:00:00'), 'Coffee maker on'],
      ['violation', at('2027-01-16T22:37:00'), 'Don’t let the garage pipes freeze.'],
      // The check had nobody home until 6 PM Sunday; after that, the household as it is.
      ['arrives', Date.parse(SUN), '3 people come home'],
    ]);
  });

  test('someone home only in the presence the check used comes home, and is marked so', () => {
    const back = {
      ...run,
      presence: [
        { fromMs: at('2027-01-15T18:00:00'), toMs: at('2027-01-17T14:00:00'), who: 'nobody' },
        { fromMs: at('2027-01-17T14:00:00'), toMs: Date.parse(SUN), who: { home: ['om'] } },
      ],
    } as Run;
    const people = markersOf(back, devices, household).filter(
      (m) => m.kind === 'leaves' || m.kind === 'arrives',
    );
    expect(people.map((m) => [m.kind, m.label])).toEqual([
      ['leaves', '3 people leave'],
      ['arrives', 'Someone comes home'],
      ['arrives', '2 people come home'],
    ]);
  });
});
