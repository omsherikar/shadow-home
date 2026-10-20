import { describe, expect, test } from 'vitest';
import { newNonce, signPlanId } from './plan-id.ts';
import {
  addRuleInput,
  approveInput,
  commitInput,
  homeStateInput,
  logInput,
  previewInput,
  undoInput,
} from './schemas.ts';

const tvOff = {
  intent: 'TV off',
  requestedBy: 'om',
  actions: [{ device: 'plug_tv', set: { onOff: false } }],
};
const away = {
  from: '2027-01-15T18:00:00-06:00',
  to: '2027-01-17T18:00:00-06:00',
  presence: 'nobody',
};
const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('what a caller sends is bounded', () => {
  test('a request in words up to 300 characters, and a rule the same', () => {
    expect(ok(previewInput, { ...tvOff, intent: 'a'.repeat(300) })).toBe(true);
    expect(ok(previewInput, { ...tvOff, intent: 'a'.repeat(301) })).toBe(false);
    const rule = { text: 'Keep the porch light off after midnight.', author: 'maya' };
    expect(ok(addRuleInput, { ...rule, text: 'a'.repeat(300) })).toBe(true);
    expect(ok(addRuleInput, { ...rule, text: 'a'.repeat(301) })).toBe(false);
  });

  test('words that are only spaces and control characters are refused', () => {
    expect(ok(previewInput, { ...tvOff, intent: ' \u0000\n\u001b ' })).toBe(false);
    expect(ok(addRuleInput, { text: '\t\u0007', author: 'om' })).toBe(false);
  });

  test('a household member ID up to 40 characters, wherever one is sent', () => {
    const long = 'm'.repeat(41);
    expect(ok(previewInput, { ...tvOff, requestedBy: 'm'.repeat(40) })).toBe(true);
    expect(ok(previewInput, { ...tvOff, requestedBy: long })).toBe(false);
    expect(ok(addRuleInput, { text: 'Lights off at midnight.', author: long })).toBe(false);
    expect(ok(logInput, { person: long })).toBe(false);
  });

  test('a presence schedule of at most 20 entries', () => {
    expect(ok(previewInput, { ...tvOff, presenceSchedule: Array(20).fill(away) })).toBe(true);
    expect(ok(previewInput, { ...tvOff, presenceSchedule: Array(21).fill(away) })).toBe(false);
  });

  test('plan IDs and tokens up to well past the longest the server issues', () => {
    // A plan ID with a state version far past any real home's still fits.
    const issued = signPlanId('k', { n: newNonce(), v: 999_999_999, x: Date.parse('2099-01-01') });
    expect(issued.length).toBeLessThan(150);
    expect(ok(commitInput, { planId: issued })).toBe(true);
    expect(ok(commitInput, { planId: 'p'.repeat(201) })).toBe(false);
    const token = 't'.repeat(100);
    expect(ok(approveInput, { planId: issued, approvalToken: token })).toBe(true);
    expect(ok(approveInput, { planId: issued, approvalToken: `${token}t` })).toBe(false);
    expect(ok(approveInput, { planId: 'p'.repeat(201), approvalToken: 'x' })).toBe(false);
    expect(ok(undoInput, { token })).toBe(true);
    expect(ok(undoInput, { token: `${token}t` })).toBe(false);
  });

  test('device and room names are bounded too', () => {
    const devices = (n: number) => Array(n).fill('thermostat_main');
    expect(ok(undoInput, { token: 'last', devices: devices(50) })).toBe(true);
    expect(ok(undoInput, { token: 'last', devices: devices(51) })).toBe(false);
    expect(ok(undoInput, { token: 'last', devices: ['d'.repeat(101)] })).toBe(false);
    expect(ok(homeStateInput, { room: 'r'.repeat(101) })).toBe(false);
  });

  test("a plan's names and values, and who it says is home, are bounded at the tool boundary", () => {
    const long = 'x'.repeat(101);
    const plan = (action: unknown) => ({ ...tvOff, actions: [action] });
    expect(ok(previewInput, plan({ device: long, set: { onOff: false } }))).toBe(false);
    expect(ok(previewInput, plan({ device: 'front_door_lock', set: { lockState: long } }))).toBe(
      false,
    );
    expect(ok(previewInput, plan({ mode: long }))).toBe(false);
    const crowd = { ...away, presence: { home: Array(21).fill('om') } };
    expect(ok(previewInput, { ...tvOff, presenceSchedule: [crowd] })).toBe(false);
  });
});

describe('a plan with no actions', () => {
  const leaving = { intent: "I'm heading out.", requestedBy: 'om', actions: [] };

  test('is a check of the house as someone leaves, so it needs a presence schedule', () => {
    expect(ok(previewInput, { ...leaving, presenceSchedule: [away] })).toBe(true);
    expect(ok(previewInput, leaving)).toBe(false);
    expect(ok(previewInput, { ...leaving, presenceSchedule: [] })).toBe(false);
  });
});
