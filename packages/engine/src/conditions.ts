import { type Cond, own, type Value } from '@shadow-home/twin';
import { not, type Truth } from './logic.ts';
import { clockMinutes } from './time.ts';

/** The home at one simulation step. */
export interface Frame {
  ms: number;
  /** Minutes since local midnight. */
  localMinute: number;
  devices: ReadonlyMap<string, Readonly<Record<string, Value>>>;
  presence: Readonly<Record<string, 'home' | 'away'>>;
  zoneTempC: Readonly<Record<string, number>>;
  /** "device\u0000attr" keys the plan or a routine has written so far. */
  commanded?: ReadonlySet<string>;
}

/** The key `Frame.commanded` uses for a device attribute. */
export function commandKey(device: string, attr: string): string {
  return `${device}\u0000${attr}`;
}

/**
 * Evaluate a rule condition. Readings from untrusted devices are unknown, unless
 * `trustCommanded` is set and the plan or a routine commanded that attribute: then the commanded
 * value counts, as if the command took effect.
 */
export function evalCond(
  cond: Cond,
  frame: Frame,
  untrusted: ReadonlyMap<string, string>,
  trustCommanded = false,
): Truth {
  // any/all short-circuit with Kleene logic (as or/and do); this runs every simulated minute,
  // so it avoids building arrays.
  if ('any' in cond) {
    let unknown = false;
    for (const c of cond.any) {
      const v = evalCond(c, frame, untrusted, trustCommanded);
      if (v === true) return true;
      if (v === 'unknown') unknown = true;
    }
    return unknown ? 'unknown' : false;
  }
  if ('all' in cond) {
    let unknown = false;
    for (const c of cond.all) {
      const v = evalCond(c, frame, untrusted, trustCommanded);
      if (v === false) return false;
      if (v === 'unknown') unknown = true;
    }
    return unknown ? 'unknown' : true;
  }
  if ('not' in cond) return not(evalCond(cond.not, frame, untrusted, trustCommanded));
  if ('time' in cond) {
    const from = clockMinutes(cond.time.from);
    const to = clockMinutes(cond.time.to);
    const m = frame.localMinute;
    return from <= to ? m >= from && m < to : m >= from || m < to;
  }
  if ('presence' in cond) {
    const p = cond.presence;
    if (p === 'nobody' || p === 'anyone') {
      let someoneHome = false;
      for (const m in frame.presence) if (frame.presence[m] === 'home') someoneHome = true;
      return p === 'anyone' ? someoneHome : !someoneHome;
    }
    return (own(frame.presence, p.member) ?? 'away') === (p.is === 'home' ? 'home' : 'away');
  }
  if (
    untrusted.has(cond.device) &&
    !(trustCommanded && frame.commanded?.has(commandKey(cond.device, cond.attr)))
  ) {
    return 'unknown';
  }
  const state = frame.devices.get(cond.device);
  const value = state ? own(state, cond.attr) : undefined;
  if (value === undefined) return 'unknown';
  return 'eq' in cond ? value === cond.eq : value !== cond.neq;
}
