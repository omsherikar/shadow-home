import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
/** After a check this turn. */
const PLAN = facts('plan');
/** Plain conversation: nothing checked anywhere in it. */
const CHAT = facts('chat');

describe('after a check: nothing that says or softens the verdict, asks, or gives a number', () => {
  test.each([
    ["You're covered.", 'verdict'],
    ['That works.', 'verdict'],
    ['Your home will be fine.', 'verdict'],
    ['Nothing to worry about.', 'verdict'],
    ["The fixes aren't needed.", 'verdict'],
    ['The fixes are optional.', 'verdict'],
    ['You can skip the fixes.', 'verdict'],
    ['The garage stays warm the whole weekend.', 'verdict'],
    ['Nothing will freeze.', 'verdict'],
    ["With the fixes the garage won't get cold.", 'verdict'],
    ['Your rules are all respected.', 'verdict'],
    ['It meets every house rule.', 'verdict'],
    ['Everything is in order.', 'verdict'],
    ['You can relax.', 'verdict'],
    ['All your rules are happy with it.', 'verdict'],
    ['It passed the check.', 'verdict'],
    ['It failed the check.', 'verdict'],
    ['Om would approve.', 'verdict'],
    ['It is approved.', 'verdict'],
    ['It got the green light.', 'verdict'],
    ['Nothing stands in the way.', 'verdict'],
    ['The twin found nothing.', 'verdict'],
    ['The twin found no conflicts.', 'verdict'],
    ['It breaks on the third night.', 'verdict'],
    ["Om set this rule so the garage would never drop that low, and it won't.", 'verdict'],
    ['None of your house rules are broken.', 'verdict'],
    ["It's not unsafe at all.", 'verdict'],
    ["It's taken care of.", 'action'],
    ['The heater is on now.', 'action'],
    ["I've unlocked the front door.", 'action'],
    ["The door's locked now.", 'state'],
    ['The door gets locked at 6:30 PM.', 'state'],
    ['The coffee maker turns off by itself.', 'state'],
    ['The heater stays off while you are away.', 'state'],
    ['Say yes to keep the plan as it is.', 'question'],
    ['Let me know if you want the fixes', 'question'],
    ['Just say the word', 'question'],
    ['Want to try it anyway?', 'question'],
    ['Ready to go?', 'question'],
    ['The garage freezes at 7 AM.', 'time'],
    ['The garage freezes at 5:45 PM.', 'time'],
    ['The garage freezes at 11 PM.', 'time'],
    ['The garage freezes at 6:30 PM on Sunday.', 'time'],
    ['The garage freezes Sunday at 10:37 PM.', 'time'],
    ['The garage drops to 7 degrees.', 'number'],
    ['Zero rules are involved.', 'number'],
  ])('%s (%s)', (sentence, why) => {
    expect(dropReason(sentence, PLAN)).toBe(why);
  });

  test.each([
    'The fix pauses the Good night routine until Sunday.',
    'Om set that rule to keep the garage pipes from freezing.',
    'With the heater lowered, the garage would get too cold by Saturday night.',
  ])(
    '%s is said: names are taken out first, and a state is fine as what would happen',
    (sentence) => {
      expect(dropReason(sentence, PLAN)).toBeNull();
    },
  );
});

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

describe('what can be spoken at all', () => {
  test.each([
    ['The garage gets cold 🚫.', 'plain'],
    ['- the coffee maker', 'plain'],
    ['1) the garage.', 'plain'],
    ['See https://example.test/rules.', 'plain'],
    ['The plug_coffee_maker stays on.', 'plain'],
    [`The garage ${'gets colder and '.repeat(9)}colder.`, 'long'],
  ])('%s', (sentence, why) => {
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

/** The demo home itself, for the cases its own names and states make hard. */
const demo = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../../fixtures/demo-home.json'), 'utf8'),
) as {
  devices: { id: string; name: string; state: Record<string, unknown> }[];
  routines: { name: string }[];
};
const home = (
  context: Context,
  over: { results?: unknown[]; about?: unknown; heard?: string; afterPlan?: boolean } = {},
) =>
  filterFacts({
    context,
    results: over.results ?? [],
    devices: demo.devices,
    routines: demo.routines.map((r) => r.name),
    ...over,
  });

describe('a state after a check only as what would happen, since nothing has run', () => {
  test.each([
    'The house is in away mode.',
    'The heat is down.',
    'Your doors are secure.',
    'The lights are dimmed.',
    'The thermostat is lowered.',
    'The front door lock is engaged.',
    'The heater is heating.',
  ])('%s', (sentence) => {
    expect(dropReason(sentence, home('plan'))).toBe('state');
  });

  test('said as what would happen, it may be', () => {
    expect(dropReason('The house would be in away mode.', home('plan'))).toBeNull();
    expect(dropReason('If the heat is down, the pipes get cold.', home('plan'))).toBeNull();
  });
});

describe('a bare yes or no says nothing, in any turn', () => {
  test.each(['Yes.', 'No.', 'Yes, it is.', 'Yep', 'Yes, the front door is.', 'No, it isn’t.'])(
    '%s',
    (sentence) => {
      for (const context of ['plan', 'anchored', 'read', 'chat'] as const) {
        expect(dropReason(sentence, home(context))).toBe('fragment');
      }
    },
  );

  test('"No problem." is not a bare no', () => {
    expect(dropReason('No problem.', home('chat'))).toBeNull();
  });
});
