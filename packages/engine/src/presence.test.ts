import type { Plan } from '@shadow-home/twin';
import { expect, test } from 'vitest';
import { awayUnstated } from './presence.ts';

const NOW = '2027-01-15T17:45:00-06:00';
const WEEKEND = [
  {
    from: '2027-01-15T18:00:00-06:00',
    to: '2027-01-17T18:00:00-06:00',
    presence: 'nobody' as const,
  },
];

test.each<[string, boolean, Plan]>([
  [
    'away mode and no presence schedule',
    true,
    { context: { now: NOW }, actions: [{ mode: 'away' }] },
  ],
  [
    'away mode later and an empty presence schedule',
    true,
    {
      context: { now: NOW, presenceSchedule: [] },
      actions: [{ mode: 'away', at: '2027-01-15T19:00:00-06:00' }],
    },
  ],
  [
    'away mode with a presence schedule',
    false,
    { context: { now: NOW, presenceSchedule: WEEKEND }, actions: [{ mode: 'away' }] },
  ],
  ['home mode', false, { context: { now: NOW }, actions: [{ mode: 'home' }] }],
  [
    'no mode change',
    false,
    { context: { now: NOW }, actions: [{ device: 'plug_tv', set: { onOff: false } }] },
  ],
])("%s: who's away is unstated is %s", (_label, expected, plan) => {
  expect(awayUnstated(plan)).toBe(expected);
});
