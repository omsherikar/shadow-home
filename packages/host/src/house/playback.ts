/**
 * Replaying a checked plan in the house: the engine's own run, played forward in seconds. Pure
 * functions over what the preview returned (its timeline, the rules it breaks, the temperature
 * trace); the house never simulates anything itself.
 */
import type { Value } from './looks.ts';

export interface Change {
  atMs: number;
  device: string;
  attr: string;
  to: Value;
}

/** A moment worth stopping on: a rule breaking, or something the twin couldn't establish. */
export interface Break {
  /** A rule broken, a rule that may break, a reading that can't be trusted, or a rule's hours starting. */
  kind: 'violation' | 'not_robust' | 'unknown' | 'guard';
  atMs: number;
  /** The rule's ID and words, and whose rule it is. Unknowns have only words. */
  rule?: string;
  text: string;
  author?: string;
  /** The device to look at: the cause of the break, or the sensor that can't be read. */
  device?: string;
}
