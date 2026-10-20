import { describe, expect, test } from 'vitest';
import {
  fitHistory,
  MAX_ARGUMENTS,
  MAX_HISTORY,
  MAX_RESULT,
  MAX_TEXT,
  spokenText,
} from './bounds.ts';
import { turnRequest } from './request.ts';
import type { Remembered } from './types.ts';

const heard = (text: string) => ({ name: 'heard', arguments: { text } });
const said = (text: string) => ({ name: 'said', arguments: { text } });
const preview = (planId: string, pad = 0) => ({
  name: 'preview_plan',
  arguments: { intent: 'TV off', actions: [{ device: 'plug_tv', set: { onOff: false } }] },
  structuredContent: { planId, verdict: 'SAFE', tier: 'T0', timeline: 'x'.repeat(pad) },
});
const ok = (history: unknown[]) => turnRequest.safeParse({ text: 'yes', history }).success;
const size = (value: unknown) => JSON.stringify(value).length;

describe('what a turn may carry', () => {
  test('a long session of the largest real previews fits', () => {
    // The weekend preview, the largest result in the demo and ShadowBench, is about 9 kB. The
    // browser keeps at most 41 entries: a heard, a preview and a said for each turn.
    const turns = Array.from({ length: 14 }, (_, i) => [
      heard("I'm away for the weekend, set the house to away."),
      preview(`p${i}`, 9_000),
      said('Blocked: that breaks 4 house rules.'),
    ]).flat();
    expect(turns.length).toBeGreaterThanOrEqual(41);
    expect(ok(turns.slice(-41))).toBe(true);
  });

  test('a history past its size is refused, whatever its length in entries', () => {
    const big = (i: number) => preview(`p${i}`, MAX_RESULT - 200);
    const count = Math.ceil(MAX_HISTORY / MAX_RESULT) + 1;
    expect(count).toBeLessThanOrEqual(50);
    expect(ok(Array.from({ length: count - 2 }, (_, i) => big(i)))).toBe(true);
    expect(ok(Array.from({ length: count }, (_, i) => big(i)))).toBe(false);
  });

  test("one entry's arguments or result past its size is refused", () => {
    expect(ok([heard('a'.repeat(MAX_ARGUMENTS - 100))])).toBe(true);
    expect(ok([heard('a'.repeat(MAX_ARGUMENTS))])).toBe(false);
    expect(ok([preview('p1', MAX_RESULT - 200)])).toBe(true);
    expect(ok([preview('p1', MAX_RESULT)])).toBe(false);
  });

  test('arguments nested too deep to measure are refused, not a crash', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(ok([{ name: 'heard', arguments: { text: deep } }])).toBe(false);
  });

  test('what the person says is at most 300 characters, as a request or a rule is', () => {
    expect(MAX_TEXT).toBe(300);
    expect(turnRequest.safeParse({ text: 'a'.repeat(300), history: [] }).success).toBe(true);
    expect(turnRequest.safeParse({ text: 'a'.repeat(301), history: [] }).success).toBe(false);
  });

  test('a long spoken line is cut to 300 characters, so its turn is accepted', () => {
    expect(spokenText('  Lights off.  ')).toBe('Lights off.');
    const long = spokenText(`${'word '.repeat(100)}`);
    expect(long.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(turnRequest.safeParse({ text: long, history: [] }).success).toBe(true);
    // Never half of a character written as two code units.
    const emoji = spokenText(`${'a'.repeat(299)}😀 and more`);
    expect(emoji).toBe('a'.repeat(299));
  });
});

describe('the history the browser sends', () => {
  /** An activity log result: `n` commits, each with a 300-character request and 10 changes. */
  const log = (n: number): Remembered => {
    const entries = Array.from({ length: n }, (_, i) => ({
      id: `log_${i}`,
      at: '2027-01-15T17:45:00-06:00',
      who: 'om',
      source: 'plan',
      what: 'w'.repeat(300),
      verdict: 'SAFE',
      tier: 'T0',
      changes: Array.from({ length: 10 }, () => ({
        target: 'plug_bedroom_space_heater',
        attr: 'onOff',
        from: true,
        to: false,
      })),
      undoable: true,
      undoToken: `undo_${i}`,
    }));
    const groups = entries.map((e) => ({ cause: e.id, label: e.what, entryIds: [e.id] }));
    return { name: 'get_activity_log', arguments: {}, structuredContent: { entries, groups } };
  };

  test('an ordinary session goes as it is', () => {
    const history = [heard('What changed?'), log(3), said('Here is what changed.')];
    expect(fitHistory(history)).toEqual(history);
  });

  test('a result past its cap goes as a note that it was left out, and the turn is accepted', () => {
    const busy = log(50);
    expect(size(busy.structuredContent)).toBeGreaterThan(MAX_RESULT);
    expect(ok([heard('What changed?'), busy])).toBe(false);
    const sent = fitHistory([heard('What changed?'), busy]);
    expect(sent).toEqual([
      heard('What changed?'),
      {
        name: 'get_activity_log',
        arguments: {},
        structuredContent: { leftOut: 'Too large to send back.' },
      },
    ]);
    expect(ok(sent)).toBe(true);
  });

  test('arguments past their cap go as the same note', () => {
    const sent = fitHistory([heard('a'.repeat(MAX_ARGUMENTS))]);
    expect(sent).toEqual([{ name: 'heard', arguments: { leftOut: 'Too large to send back.' } }]);
    expect(ok(sent)).toBe(true);
  });

  test('while the whole is past its cap, the oldest entries go first', () => {
    // Log results just inside the per-result cap, asked for turn after turn.
    let n = 1;
    while (size(log(n + 1).structuredContent) <= 60_000) n++;
    const history = Array.from({ length: 5 }, (_, i) => [
      heard(`What changed? ${i}`),
      log(n),
      said(`Here is what changed. ${i}`),
    ]).flat();
    expect(ok(history)).toBe(false);
    const sent = fitHistory(history);
    expect(ok(sent)).toBe(true);
    expect(size(sent)).toBeLessThanOrEqual(MAX_HISTORY);
    expect(sent.length).toBeLessThan(history.length);
    expect(sent).toEqual(history.slice(history.length - sent.length));
  });
});
