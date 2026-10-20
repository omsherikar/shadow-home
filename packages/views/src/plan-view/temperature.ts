import type { TemperatureRule, TemperatureTrace } from './types.ts';

/** What a tool result's `_meta` gives for drawing temperatures: traces by plan ID, and the rules. */
export interface Temperatures {
  traces: Record<string, TemperatureTrace>;
  rules: Record<string, TemperatureRule>;
}

export const NO_TEMPERATURES: Temperatures = { traces: {}, rules: {} };
