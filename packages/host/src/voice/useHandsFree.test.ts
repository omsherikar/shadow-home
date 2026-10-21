import { describe, expect, test } from 'vitest';
import { type HandsFree, OFF } from './machine.ts';
import { shouldListen } from './useHandsFree.ts';

const inMode = (mode: HandsFree['mode']): HandsFree => ({ ...OFF, mode });

describe('when the microphone listens', () => {
  test('in a listening state, only while the page is in view', () => {
    for (const mode of ['idle', 'awake', 'answer'] as const) {
      expect(shouldListen(inMode(mode), true), mode).toBe(true);
      // A hidden tab sends nothing to be recognised.
      expect(shouldListen(inMode(mode), false), mode).toBe(false);
    }
  });

  test('never while off, or while she thinks or speaks', () => {
    for (const mode of ['off', 'thinking', 'speaking'] as const) {
      expect(shouldListen(inMode(mode), true), mode).toBe(false);
    }
  });
});
