import { describe, expect, test } from 'vitest';
import {
  type Context,
  dropReason,
  type FilterFacts,
  filterFacts,
  numbersIn,
  timesIn,
} from './guard.ts';

const devices = [
  { id: 'front_door_lock', name: 'Front door lock' },
  { id: 'garage_thermostat', name: 'Garage heater thermostat' },
  { id: 'light_porch', name: 'Porch light' },
  { id: 'plug_tv', name: 'TV' },
  { id: 'plug_coffee_maker', name: 'Coffee maker' },
];
const routines = ['Coffee at 7', 'Good night', 'Lights out'];
const facts = (context: Context, results: unknown[] = []): FilterFacts =>
  filterFacts({ context, results, devices, routines });
/** Plain conversation: nothing checked anywhere in it. */
const CHAT = facts('chat');

describe('plain conversation: small talk is free, claims about the home are not', () => {
  test.each([
    'Good morning!',
    'Sure, I can help.',
    'No problem.',
    "I'm doing great, thanks.",
    'Hello! What can I check for you?',
  ])('%s is said', (sentence) => {
    expect(dropReason(sentence, CHAT)).toBeNull();
  });

  test.each([
    ["It's taken care of.", 'action'],
    ["I've locked the front door.", 'action'],
    ['Done.', 'action'],
  ])('%s is dropped (%s)', (sentence, why) => {
    expect(dropReason(sentence, CHAT)).toBe(why);
  });
});

describe('times and numbers as people say them', () => {
  test('times on the 24-hour clock', () => {
    const keys = (t: string) => timesIn(t).times;
    expect(keys('at 9pm, 9 p.m. or 10:37 PM')).toEqual([['21:0'], ['21:0'], ['22:37']]);
    expect(keys('ten thirty-seven PM, seven oh five am')).toEqual([['22:37'], ['7:5']]);
    expect(keys('noon, midnight, 22:30, 07:00, 10:30')).toEqual([
      ['22:30'],
      ['7:0'],
      ['10:30', '22:30'],
      ['12:0'],
      ['0:0'],
    ]);
    expect(keys('37 pm')).toEqual([[]]);
  });

  test('numbers in digits and words, not in names', () => {
    expect(numbersIn('4.5 °C, twenty-five, four, 1,500, a dozen, the third')).toEqual([
      4.5, 1500, 25, 4, 12, 3,
    ]);
    expect(numbersIn('no one, the one that, first, rule R3, plan p1')).toEqual([]);
  });
});
