import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { pick } from '../proxy.ts';
import { VIEW_CSP, withPolicy } from '../screen/ScreenHost.ts';
import { runTurn, type ToolRunner } from './run.ts';
import {
  type Beat,
  bestBeat,
  normalise,
  recordedFrom,
  scriptedModel,
  spokenFrom,
} from './scripted.ts';
import type { Remembered } from './types.ts';

const script = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../../fixtures/demo-script.json'), 'utf8'),
) as { beats: Beat[] };
const model = scriptedModel(script.beats);

/** The first step the scripted model takes for a line, given what was said before. */
async function firstStep(text: string, history: Remembered[] = []) {
  return model.next({ text, history, thisTurn: [] });
}

const preview = (sc: Record<string, unknown>): Remembered => ({
  name: 'preview_plan',
  arguments: {},
  structuredContent: { planId: 'p1', kind: 'plan', repair: null, safePart: null, ...sc },
});

describe('the scripted stand-in for the model', () => {
  test('a demo line drafts its scripted plan, with the context the line implies', async () => {
    const step = await firstStep("I'm away for the weekend, set the house to away.");
    expect(step).toMatchObject({
      call: {
        name: 'preview_plan',
        arguments: {
          requestedBy: 'om',
          planEnd: '2027-01-17T18:00:00-06:00',
          presenceSchedule: [{ presence: 'nobody' }],
        },
      },
    });
    if (!('call' in step)) throw new Error('expected a call');
    expect(step.call.arguments.actions).toHaveLength(7);
  });

  test('a line close to a demo line still finds it; an unrelated one does not', () => {
    expect(bestBeat(normalise('run the dishwasher at 2am, power is cheap'), script.beats)?.id).toBe(
      'dishwasher_2am',
    );
    expect(bestBeat(normalise('play some jazz'), script.beats)).toBeUndefined();
  });

  test('a yes commits what the last question offered', async () => {
    const repair = { planId: 'r1', verdict: 'SAFE', tier: 'T1' };
    const yesTo = async (h: Remembered) => {
      const step = await firstStep('yes', [h]);
      return 'call' in step ? step.call.arguments : step;
    };
    expect(await yesTo(preview({ tier: 'T3', verdict: 'UNSAFE', repair }))).toEqual({
      planId: 'r1',
      confirmed: true,
    });
    expect(
      await yesTo(preview({ tier: 'T4', verdict: 'UNPROVEN', safePart: { planId: 's1' } })),
    ).toEqual({ planId: 'p1', safePartOnly: true, confirmed: true });
    expect(await yesTo(preview({ tier: 'T2', verdict: 'SAFE' }))).toEqual({
      planId: 'p1',
      confirmed: true,
    });
    expect(await yesTo(preview({ tier: 'T5', verdict: 'UNSAFE' }))).toEqual({ say: 'Okay.' });
    expect(
      await yesTo({
        name: 'commit_plan',
        arguments: {},
        structuredContent: { status: 'needs_confirmation', planId: 's1' },
      }),
    ).toEqual({ planId: 's1', confirmed: true });
  });

  test('a no, a Cancel tap or another request closes the question; a later yes answers nothing', async () => {
    const t2 = preview({ tier: 'T2', verdict: 'SAFE' });
    const nothing = { say: "There's nothing waiting for a yes." };
    expect(await firstStep('yes', [t2, { name: 'heard', arguments: { text: 'no' } }])).toEqual(
      nothing,
    );
    expect(await firstStep('yes', [t2, { name: 'closed', arguments: {} }])).toEqual(nothing);
    const log = { name: 'get_activity_log', arguments: {}, structuredContent: { entries: [] } };
    expect(await firstStep('yes', [t2, log])).toEqual(nothing);
  });

  test('the assistant asking the question does not close it', async () => {
    const t2 = preview({ tier: 'T2', verdict: 'SAFE' });
    const asked: Remembered = { name: 'said', arguments: { text: 'Back door lock unlocked?' } };
    expect(await firstStep('Yes.', [t2, asked])).toMatchObject({
      call: { name: 'commit_plan', arguments: { planId: 'p1', confirmed: true } },
    });
  });

  test('only a whole yes is a yes: "okay, what changed?" reads the log', async () => {
    const t2 = preview({ tier: 'T2', verdict: 'SAFE' });
    expect(await firstStep('Okay, what changed?', [t2])).toEqual({
      call: { name: 'get_activity_log', arguments: {} },
    });
    expect(await firstStep('Yes please', [t2])).toMatchObject({ call: { name: 'commit_plan' } });
  });

  test('a yes to an undo answers the undo’s own question, like any plan', async () => {
    const undo = (p: Record<string, unknown>): Remembered => ({
      name: 'undo',
      arguments: { token: 'last' },
      structuredContent: { status: 'preview', preview: { planId: 'u1', kind: 'undo', ...p } },
    });
    const step = await firstStep('yes', [
      undo({ tier: 'T4', verdict: 'UNPROVEN', safePart: { planId: 's1' } }),
    ]);
    expect(step).toEqual({
      call: {
        name: 'commit_plan',
        arguments: { planId: 'u1', safePartOnly: true, confirmed: true },
      },
    });
    // "Run it anyway" acts on the undo on screen, not on an earlier plan still in the history.
    const earlier = preview({ tier: 'T4', verdict: 'UNPROVEN' });
    expect(
      await firstStep('run it anyway', [earlier, undo({ tier: 'T4', verdict: 'UNPROVEN' })]),
    ).toEqual({ call: { name: 'commit_plan', arguments: { planId: 'u1', confirmed: true } } });
  });

  test('"undo the thermostat" names the thermostats', async () => {
    const names = {
      devices: {
        thermostat_main: { name: 'Main thermostat', room: 'Living room' },
        plug_tv: { name: 'TV', room: 'Living room' },
      },
      routines: {},
      members: {},
    };
    const step = await model.next({
      text: 'Undo the thermostat.',
      history: [],
      names,
      thisTurn: [],
    });
    expect(step).toEqual({
      call: { name: 'undo', arguments: { token: 'last', devices: ['thermostat_main'] } },
    });
  });

  test('"I\'m heading out" checks the house, nobody home from this minute, with nothing to change', async () => {
    const leaving = scriptedModel(script.beats, { now: '2027-01-18T07:15:42-06:00' });
    for (const line of ["I'm heading out.", "I'm leaving", "We're heading out now."]) {
      expect(await leaving.next({ text: line, history: [], thisTurn: [] })).toEqual({
        call: {
          name: 'preview_plan',
          arguments: {
            intent: line,
            requestedBy: 'om',
            actions: [],
            presenceSchedule: [
              {
                from: '2027-01-18T07:15:00-06:00',
                to: '2027-01-18T11:15:00-06:00',
                presence: 'nobody',
              },
            ],
          },
        },
      });
    }
    // Leaving for the weekend is still the weekend line, with its own plan.
    const weekend = await leaving.next({
      text: "I'm leaving for the weekend, set the house to away.",
      history: [],
      thisTurn: [],
    });
    expect('call' in weekend && weekend.call.arguments.actions).toHaveLength(7);
  });

  test('it speaks only from the server’s speech fields', () => {
    expect(
      spokenFrom({ speech: { headline: 'Blocked.', reason: 'A rule.', ask: 'Fix it?' } }, []),
    ).toBe('Blocked. A rule. Fix it?');
    expect(spokenFrom(undefined, [{ type: 'text', text: '3 entries in 2 groups.' }])).toBe(
      '3 entries in 2 groups.',
    );
  });

  test('a turn calls tools until the model has something to say', async () => {
    const calls: string[] = [];
    const tools: ToolRunner = {
      async callTool(name) {
        calls.push(name);
        return {
          content: [{ type: 'text', text: 'SAFE (T0)' }],
          structuredContent: { speech: { headline: 'Safe: TV off.' } },
        };
      },
      resourceUriFor: (name) =>
        name === 'preview_plan' ? 'ui://shadow-home/plan-view.html' : undefined,
    };
    const turn = await runTurn(model, tools, {
      text: "I'm away for the weekend, set the house to away.",
      history: [],
    });
    expect(calls).toEqual(['preview_plan']);
    expect(turn.say).toBe('Safe: TV off.');
    expect(turn.calls[0]?.resourceUri).toBe('ui://shadow-home/plan-view.html');
  });
});

describe('putting a view on screen', () => {
  test('the content policy comes before anything in the view, whatever its HTML', () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}">`;
    for (const html of [
      '<!doctype html><html><head><title>x</title><script>1</script>',
      '<!doctype html><!--<head>--><html><head><script>1</script>',
      '<header>x</header><script>1</script>',
      '<script>1</script><head></head>',
    ]) {
      expect(withPolicy(html).startsWith(meta)).toBe(true);
    }
    expect(VIEW_CSP).toContain("default-src 'none'");
    expect(VIEW_CSP).toContain("form-action 'none'");
  });

  test('the MCP proxy passes on protocol headers and drops the browser’s own', () => {
    const forwarded = pick(
      new Headers({
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
        cookie: 'session=1',
        origin: 'http://localhost:3001',
      }),
      ['content-type', 'mcp-protocol-version'],
    );
    expect([...forwarded.keys()].sort()).toEqual(['content-type', 'mcp-protocol-version']);
  });
});

describe('recording a real model run for demo mode', () => {
  test('keeps what the model sent to preview_plan, except the intent', () => {
    expect(
      recordedFrom([
        { name: 'get_home_state', arguments: {} },
        {
          name: 'preview_plan',
          arguments: { intent: 'away', requestedBy: 'om', actions: [{ mode: 'away' }] },
        },
      ]),
    ).toEqual({ requestedBy: 'om', actions: [{ mode: 'away' }] });
    expect(recordedFrom([{ name: 'get_activity_log', arguments: {} }])).toBeNull();
  });

  test('demo mode replays a recorded plan in place of the draft', async () => {
    const recorded = scriptedModel([
      {
        id: 'b',
        say: 'Set the house to away.',
        draftPlanExample: [{ mode: 'home' }],
        recordedPlan: { actions: [{ mode: 'away' }], requestedBy: 'maya' },
      },
    ]);
    expect(
      await recorded.next({ text: 'Set the house to away.', history: [], thisTurn: [] }),
    ).toEqual({
      call: {
        name: 'preview_plan',
        arguments: {
          intent: 'Set the house to away.',
          actions: [{ mode: 'away' }],
          requestedBy: 'maya',
        },
      },
    });
  });
});
