import { join } from 'node:path';
import type { CompiledRule } from '@shadow-home/twin';
import { loadHome } from '@shadow-home/twin/node';
import { describe, expect, test } from 'vitest';
import { type CompileAnswer, compileRule, normalize, ruleHash } from './compile.ts';
import { compilerPrompt } from './prompt.ts';

const home = loadHome(join(import.meta.dirname, '../../../fixtures/demo-home.json'));
const input = { text: 'Keep the porch light off at night', author: 'om', home };
const answers =
  (...a: CompileAnswer[]) =>
  (i: number) =>
  async () =>
    a[i];
const compilersFor = (...a: CompileAnswer[]) => a.map((_, i) => answers(...a)(i));

const porch: CompiledRule = {
  template: 'never_when',
  priority: 'comfort',
  params: {
    x: { device: 'light_porch', attr: 'onOff', eq: true },
    when: { time: { from: '23:00', to: '06:00' } },
  },
};

describe('three compiles that must agree', () => {
  test('the same rule three times is kept, with the hash they agreed on', async () => {
    const out = await compileRule(
      input,
      compilersFor(...Array(3).fill({ rule: porch, unsupported: null })),
    );
    expect(out).toEqual({ status: 'agreed', rule: normalize(porch), hash: ruleHash(porch) });
  });

  test('the same meaning written differently still agrees', async () => {
    const sayItOtherwise: CompiledRule = {
      ...porch,
      params: {
        when: { time: { from: '23:00', to: '06:00' } },
        x: { not: { device: 'light_porch', attr: 'onOff', eq: false } },
      },
    };
    const notFalse: CompiledRule = {
      ...porch,
      params: { ...porch.params, x: { device: 'light_porch', attr: 'onOff', neq: false } },
    };
    const out = await compileRule(
      input,
      compilersFor(
        { rule: porch, unsupported: null },
        { rule: sayItOtherwise, unsupported: null },
        { rule: notFalse, unsupported: null },
      ),
    );
    expect(out.status).toBe('agreed');
  });

  test('lists in a different order agree', () => {
    const lights = (order: string[]): CompiledRule => ({
      template: 'never_when',
      priority: 'comfort',
      params: {
        x: { any: order.map((device) => ({ device, attr: 'onOff', eq: true })) },
        when: { presence: 'nobody' },
      },
    });
    expect(ruleHash(lights(['light_living', 'light_kitchen']))).toBe(
      ruleHash(lights(['light_kitchen', 'light_living'])),
    );
  });

  test('two readings are both returned, and nothing is kept', async () => {
    const asSecurity: CompiledRule = { ...porch, priority: 'security' };
    const out = await compileRule(
      input,
      compilersFor(
        { rule: porch, unsupported: null },
        { rule: asSecurity, unsupported: null },
        { rule: porch, unsupported: null },
      ),
    );
    expect(out).toMatchObject({ status: 'disagree', unsupported: [] });
    expect(out.status === 'disagree' && out.readings).toHaveLength(2);
  });

  test('when one compiler says it fits no template, that is a disagreement too', async () => {
    const out = await compileRule(
      input,
      compilersFor(
        { rule: porch, unsupported: null },
        { rule: null, unsupported: 'Night is not a time range.' },
        { rule: porch, unsupported: null },
      ),
    );
    expect(out).toMatchObject({ status: 'disagree', unsupported: ['Night is not a time range.'] });
  });

  test('when none can express it, the first reason is given', async () => {
    const none = { rule: null, unsupported: 'This home has no sprinkler.' };
    expect(await compileRule(input, compilersFor(none, none, none))).toEqual({
      status: 'unsupported',
      reason: 'This home has no sprinkler.',
    });
  });

  test('a compiler that fails, or answers with something that isn’t a rule, stops the compile', async () => {
    const ok = async () => ({ rule: porch, unsupported: null });
    const throws = async () => {
      throw new Error('AccessDeniedException');
    };
    const junk = async () => ({ rule: { template: 'sometimes' }, unsupported: null });
    const out = await compileRule(input, [ok, throws, junk]);
    expect(out.status).toBe('failed');
    expect(out.status === 'failed' && out.problems).toEqual([
      'compiler 2: AccessDeniedException',
      expect.stringContaining('compiler 3: not a rule'),
    ]);
  });

  test('every rule in the demo home has its own hash', () => {
    const hashes = home.rules.map(({ id: _i, text: _t, author: _a, source: _s, ...c }) =>
      ruleHash(c as CompiledRule),
    );
    expect(new Set(hashes).size).toBe(home.rules.length);
  });
});

describe('what the compiler model is told', () => {
  const prompt = compilerPrompt(home);

  test('every device with the values each attribute takes', () => {
    expect(prompt).toContain('- front_door_lock: Front door lock (');
    expect(prompt).toContain('lockState LOCKED | UNLOCKED');
    expect(prompt).toContain('heatingSetpointC 7 to 30');
    expect(prompt).toContain('- light_porch: Porch light (');
    expect(prompt).toContain('outdoor');
  });

  test('the home’s own rules as examples, compiled', () => {
    expect(prompt).toContain('"Front door locked when nobody\'s home."');
    expect(prompt).toContain('"template":"never_when"');
    // Examples carry no IDs or authors: those come from the server.
    expect(prompt).not.toContain('"id":"R4"');
  });
});
