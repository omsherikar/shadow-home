import { describe, expect, test } from 'vitest';
import { parseWake } from './wake.ts';

describe('the wake word', () => {
  test('with a request in the same breath, the request is what follows it', () => {
    expect(parseWake("Alexa, I'm away for the weekend")).toEqual({
      woke: true,
      request: "I'm away for the weekend",
    });
    expect(parseWake('alexa run the dishwasher at 2 AM')).toEqual({
      woke: true,
      request: 'run the dishwasher at 2 AM',
    });
    expect(parseWake('hey Alexa. Undo the thermostat.')).toEqual({
      woke: true,
      request: 'Undo the thermostat.',
    });
  });
});
