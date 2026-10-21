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

  test('alone, it wakes with nothing asked yet', () => {
    for (const heard of ['Alexa', 'alexa.', ' Alexa? ', 'Alexa Alexa']) {
      expect(parseWake(heard), heard).toEqual({ woke: true, request: '' });
    }
  });

  test('as speech recognition often writes it, when that is the first thing said', () => {
    for (const heard of ['Alexia', 'a lexa', 'Alexis', 'Elexa', "Alexa's", 'hey Alexia']) {
      expect(parseWake(`${heard} what did you change`), heard).toEqual({
        woke: true,
        request: 'what did you change',
      });
    }
  });

  test('anything without it is not for her', () => {
    for (const heard of [
      "I'm away for the weekend",
      'yes',
      'Alexander came by',
      'the lexicon',
      'Alexandra said hi',
      '',
    ]) {
      expect(parseWake(heard), heard).toEqual({ woke: false });
    }
  });
});
