import { describe, expect, test } from 'vitest';
import { addRuleInput, logInput, previewInput } from './schemas.ts';

const tvOff = {
  intent: 'TV off',
  requestedBy: 'om',
  actions: [{ device: 'plug_tv', set: { onOff: false } }],
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

  test('a household member ID up to 40 characters, wherever one is sent', () => {
    const long = 'm'.repeat(41);
    expect(ok(previewInput, { ...tvOff, requestedBy: 'm'.repeat(40) })).toBe(true);
    expect(ok(previewInput, { ...tvOff, requestedBy: long })).toBe(false);
    expect(ok(addRuleInput, { text: 'Lights off at midnight.', author: long })).toBe(false);
    expect(ok(logInput, { person: long })).toBe(false);
  });
});
