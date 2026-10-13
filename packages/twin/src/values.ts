import { findClusterAttr } from './clusters.ts';
import { own } from './records.ts';
import type { Capability, Device, Value } from './schema.ts';

export type ValueProblemCode = 'wrong_type' | 'out_of_range' | 'off_step' | 'not_in_enum';

export interface ValueProblem {
  code: ValueProblemCode;
  message: string;
}

const STEP_EPSILON = 1e-9;

/** Why `value` can't be written to an attribute with this capability, or null if it can. */
export function checkValue(cap: Capability, value: Value): ValueProblem | null {
  switch (cap.type) {
    case 'boolean':
      return typeof value === 'boolean'
        ? null
        : { code: 'wrong_type', message: `expected true or false, got ${show(value)}` };
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { code: 'wrong_type', message: `expected a number, got ${show(value)}` };
      }
      if (value < cap.min || value > cap.max) {
        return { code: 'out_of_range', message: `${value} is outside ${cap.min} to ${cap.max}` };
      }
      const steps = (value - cap.min) / cap.step;
      if (Math.abs(steps - Math.round(steps)) > STEP_EPSILON) {
        return {
          code: 'off_step',
          message: `${value} is not a multiple of ${cap.step} from ${cap.min}`,
        };
      }
      return null;
    }
    case 'enum':
      return typeof value === 'string' && cap.values.includes(value)
        ? null
        : {
            code: 'not_in_enum',
            message: `expected one of ${cap.values.join(', ')}, got ${show(value)}`,
          };
  }
}

function show(value: Value): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

/**
 * The values `attr` can hold on this device: its capability when writable, otherwise the
 * read-only domain from its Matter cluster. Undefined when the device has no such attribute.
 */
export function attrDomain(device: Device, attr: string): Capability | undefined {
  return own(device.capabilities, attr) ?? findClusterAttr(device.matter.clusters, attr)?.domain;
}
