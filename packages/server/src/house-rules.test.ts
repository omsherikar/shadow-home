import { join } from 'node:path';
import { type Compile, compileRule } from '@shadow-home/rules';
import type { CompiledRule } from '@shadow-home/twin';
import { loadHome } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { manualClock } from './clock.ts';
import { withDeadline } from './compiler.ts';
import { initialState } from './live-home.ts';
import { ShadowHomeService } from './service.ts';
import { memoryStore } from './store.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));

/** Three compilers answering as given, behind the real agreement check. */
function setup(...answers: unknown[]) {
  const store = memoryStore(initialState(home));
  const compilers: Compile[] = answers.map((a) => async () => a);
  const service = new ShadowHomeService({
    store,
    clock: manualClock(Date.parse('2027-01-15T17:45:00-06:00')),
    secret: 'unit',
    compileRule: (input) => compileRule(input, compilers),
  });
  return { store, service };
}

const porch: CompiledRule = {
  template: 'never_when',
  priority: 'comfort',
  params: {
    x: { device: 'light_porch', attr: 'onOff', eq: true },
    when: { time: { from: '00:00', to: '06:00' } },
  },
};
const says = { text: 'Keep the porch light off after midnight.', author: 'maya' };

describe('a house rule in plain words', () => {
  test('when all three compiles agree, it is added with the hash they agreed on', async () => {
    const { store, service } = setup(...Array(3).fill({ rule: porch, unsupported: null }));
    const r = await service.addHouseRule(says);
    expect(r).toMatchObject({
      status: 'added',
      ruleId: 'R13',
      readBack: "Never: Porch light is on, when it's between 00:00 and 06:00.",
      speech: { headline: 'Rule added.' },
    });
    const added = (await store.loadState()).home.rules.find((x) => x.id === 'R13');
    expect(added).toMatchObject({ text: says.text, author: 'maya', template: 'never_when' });
    expect(added?.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test('when they read it differently, each reading is said back and nothing is added', async () => {
    const tillSix = { rule: porch, unsupported: null };
    const allNight = {
      rule: {
        ...porch,
        params: { ...porch.params, when: { time: { from: '00:00', to: '23:59' } } },
      },
      unsupported: null,
    };
    const { store, service } = setup(tillSix, allNight, tillSix);
    const r = await service.addHouseRule(says);
    expect(r).toMatchObject({
      status: 'unclear',
      readings: [
        "Never: Porch light is on, when it's between 00:00 and 06:00.",
        "Never: Porch light is on, when it's between 00:00 and 23:59.",
      ],
      speech: {
        headline: "I'm not sure what that rule means.",
        reason: 'I can read it 2 ways.',
        ask: 'Can you say it again, naming the device and when it applies?',
      },
    });
    expect((await store.loadState()).home.rules).toHaveLength(home.rules.length);
  });

  test('when none can express it, the reason is given', async () => {
    const none = { rule: null, unsupported: 'This home has no sprinkler.' };
    const { service } = setup(none, none, none);
    expect(
      await service.addHouseRule({ text: 'Water the lawn when it’s dry.', author: 'om' }),
    ).toMatchObject({
      status: 'invalid',
      problems: ['This home has no sprinkler.'],
      // The compiler's reason is shown, not spoken: speech is the server's own words.
      speech: {
        headline: "I can't make that a house rule.",
        reason: "It doesn't fit the kinds of rule I can check.",
      },
    });
  });

  test('when a compiler can’t be reached, nothing is guessed', async () => {
    const store = memoryStore(initialState(home));
    const service = new ShadowHomeService({
      store,
      clock: manualClock(Date.parse('2027-01-15T17:45:00-06:00')),
      secret: 'unit',
      compileRule: (input) =>
        compileRule(input, [
          async () => ({ rule: porch, unsupported: null }),
          async () => {
            throw new Error('AccessDeniedException');
          },
        ]),
    });
    expect(await service.addHouseRule(says)).toMatchObject({
      status: 'needs_compiler',
      problems: ['compiler 2: AccessDeniedException'],
      speech: { headline: "I couldn't work out that rule just now." },
    });
  });

  test('an agreed rule naming a device the home lacks is still refused', async () => {
    const ghost = {
      rule: {
        ...porch,
        params: { ...porch.params, x: { device: 'sprinkler', attr: 'onOff', eq: true } },
      },
      unsupported: null,
    };
    const { service } = setup(ghost, ghost, ghost);
    expect((await service.addHouseRule(says)).status).toBe('invalid');
  });

  test('readings that differ only in how strict they are say so, and name each', async () => {
    const asComfort = { rule: porch, unsupported: null };
    const asSecurity = { rule: { ...porch, priority: 'security' }, unsupported: null };
    const { service } = setup(asComfort, asSecurity, asComfort);
    expect(await service.addHouseRule(says)).toMatchObject({
      status: 'unclear',
      readings: [
        "Never: Porch light is on, when it's between 00:00 and 06:00. (comfort)",
        "Never: Porch light is on, when it's between 00:00 and 06:00. (security)",
      ],
      speech: {
        headline: "I'm not sure how strict that rule is.",
        ask: "Can you say it again, and say whether it's about safety, security, a device, or comfort?",
      },
    });
  });

  test('with a compiler, a compiled rule from the caller doesn’t skip the agreement', async () => {
    const { store, service } = setup(...Array(3).fill({ rule: porch, unsupported: null }));
    const r = await service.addHouseRule({
      ...says,
      rule: { ...porch, priority: 'life-safety', refuse: true },
    });
    expect(r.status).toBe('added');
    const added = (await store.loadState()).home.rules.find((x) => x.id === r.ruleId);
    expect(added).toMatchObject({ priority: 'comfort' });
    expect(added?.refuse).toBeUndefined();
  });

  test('the words and author are compiled and kept without control characters, runs of spaces made one', async () => {
    const heard: { text: string; author: string }[] = [];
    const store = memoryStore(initialState(home));
    const agree: Compile = async () => ({ rule: porch, unsupported: null });
    const service = new ShadowHomeService({
      store,
      clock: manualClock(Date.parse('2027-01-15T17:45:00-06:00')),
      secret: 'unit',
      compileRule: (input) => {
        heard.push({ text: input.text, author: input.author });
        return compileRule(input, [agree, agree, agree]);
      },
    });
    const r = await service.addHouseRule({
      text: 'Keep the porch light\u0000 off\n\n  after midnight.\u001b',
      author: 'maya\u0000\n',
    });
    expect(r.status).toBe('added');
    expect(heard).toEqual([says]);
    const added = (await store.loadState()).home.rules.find((x) => x.id === r.ruleId);
    expect(added).toMatchObject(says);
  });

  test('a compile past its deadline fails, and the rule its compilers agree on later is never added', async () => {
    const store = memoryStore(initialState(home));
    let finished = false;
    const slow: Compile = async () => {
      await new Promise((r) => setTimeout(r, 60));
      finished = true;
      return { rule: porch, unsupported: null };
    };
    const service = new ShadowHomeService({
      store,
      clock: manualClock(Date.parse('2027-01-15T17:45:00-06:00')),
      secret: 'unit',
      compileRule: withDeadline((input) => compileRule(input, [slow, slow, slow]), 10),
    });
    expect(await service.addHouseRule(says)).toMatchObject({
      status: 'needs_compiler',
      speech: { headline: "I couldn't work out that rule just now." },
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(finished).toBe(true);
    expect((await store.loadState()).home.rules).toHaveLength(home.rules.length);
  });

  test('without a compiler, words alone wait for one', async () => {
    const service = new ShadowHomeService({
      store: memoryStore(initialState(home)),
      clock: manualClock(Date.parse('2027-01-15T17:45:00-06:00')),
      secret: 'unit',
    });
    expect((await service.addHouseRule(says)).status).toBe('needs_compiler');
  });
});
