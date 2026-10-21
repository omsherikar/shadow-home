/**
 * What the house says in plain words while it plays: each change as it happens ("Garage freezer
 * off"), and at the end what each run came to ("Your plan: 4 house rules break; the garage drops
 * below 4 °C Sat 10:37 PM."). Only from the run itself: its changes, its breaks, its temperature
 * rules and its trace.
 */
import type { LiveDevice } from './looks.ts';
import { type Change, homeClock, type Run, temperaturesAt } from './playback.ts';

/** "dishwasher_latch: battery 4% …" with the device's own name: "Dishwasher door latch: …". */
export function readable(text: string, name: (id: string) => string | undefined): string {
  return text.replace(/^([a-z0-9_]+):/, (whole, id: string) => {
    const n = name(id);
    return n ? `${n}:` : whole;
  });
}

type TemperatureRule = Run['temperatureRules'][string];

/**
 * Which way a zone left a rule's bounds: below its lower limit or above its upper one. With both
 * limits, the nearer one to the zone's temperature then; without a temperature, it can't be told.
 */
function crossed(rule: TemperatureRule, tempC: number | undefined): 'below' | 'above' | null {
  if (rule.minC !== null && rule.maxC === null) return 'below';
  if (rule.maxC !== null && rule.minC === null) return 'above';
  if (rule.minC === null || rule.maxC === null || tempC === undefined) return null;
  return tempC - rule.minC <= rule.maxC - tempC ? 'below' : 'above';
}

/** The bounds a rule keeps a zone within, in words: "above 4 °C", "between 18 and 24 °C". */
function within(rule: TemperatureRule): string | null {
  if (rule.minC !== null && rule.maxC !== null) return `between ${rule.minC} and ${rule.maxC} °C`;
  if (rule.minC !== null) return `above ${rule.minC} °C`;
  if (rule.maxC !== null) return `below ${rule.maxC} °C`;
  return null;
}

/** "Garage freezer off", "Front door locked", "Main thermostat to 10 °C". */
export function changeWords(c: Change, device: LiveDevice | undefined): string {
  const name = device?.name ?? c.device;
  switch (c.attr) {
    case 'onOff':
      return `${name} ${c.to === true ? 'on' : 'off'}`;
    case 'lockState': {
      const door = name.replace(/ lock$/i, '');
      if (c.to === 'LOCKED') return `${door} locked`;
      if (c.to === 'UNLOCKED') return `${door} unlocked`;
      return `${name}: ${String(c.to).toLowerCase()}`;
    }
    case 'heatingSetpointC':
      return `${name} to ${c.to} °C`;
    case 'systemMode':
      return c.to === 'off' ? `${name} off` : `${name} set to ${c.to}`;
    case 'brightness':
      return `${name} at ${c.to}%`;
    case 'contact':
      return `${name} ${c.to}`;
    default:
      return `${name}: ${c.attr} ${String(c.to)}`;
  }
}

/** One step of the plan in words: a device, or the lights one action turns off together. */
export function stepWords(changes: Change[], devices: LiveDevice[] | null): string {
  const of = (c: Change) => devices?.find((d) => d.id === c.device);
  const first = changes[0];
  if (!first) return '';
  if (changes.length === 1) return changeWords(first, of(first));
  const lights = changes.every((c) => of(c)?.kind === 'light');
  if (first.attr === 'onOff') {
    const what = lights ? 'lights' : 'devices';
    return `${changes.length} ${what} ${first.to === true ? 'on' : 'off'}`;
  }
  return changes.map((c) => changeWords(c, of(c))).join(', ');
}

/**
 * What a run came to, in one plain sentence led by its name. Nothing for a new rule's sample day,
 * whose card already says when the rule starts guarding, nor for a run that wasn't SAFE but shows
 * nothing broken (a plan that failed its checks before it was simulated): every rule holding is
 * said only of a SAFE run.
 */
export function summaryOf(
  run: Run,
  name: (device: string) => string | undefined,
  zoneName: (zone: string) => string | undefined,
): string | null {
  if (run.breaks.some((b) => b.kind === 'guard')) return null;
  if (run.breaks.length === 0 && run.verdict !== 'SAFE') return null;
  const broken = run.breaks.filter((b) => b.kind === 'violation');
  const shaky = run.breaks.filter((b) => b.kind === 'not_robust');
  const unknown = run.breaks.filter((b) => b.kind === 'unknown');
  const zone = (id: string, given?: string) => (given ?? zoneName(id) ?? id).toLowerCase();
  const parts: string[] = [];

  if (broken.length > 0) {
    parts.push(`${broken.length} house ${broken.length === 1 ? 'rule breaks' : 'rules break'}`);
    // The break the house shows best: a room getting too cold or too warm, with its time.
    const temperature = broken.find((b) => b.rule && run.temperatureRules[b.rule]);
    const rule = temperature?.rule ? run.temperatureRules[temperature.rule] : undefined;
    const when = (ms: number) => homeClock(ms, run.offset);
    const tempC =
      temperature && rule && run.trace
        ? temperaturesAt(run.trace, temperature.atMs).zonesC[rule.zone]
        : undefined;
    const way = temperature && rule ? crossed(rule, tempC) : null;
    if (temperature && rule && way === 'below') {
      parts.push(
        `the ${zone(rule.zone, rule.zoneName)} drops below ${rule.minC} °C ${when(temperature.atMs)}`,
      );
    } else if (temperature && rule && way === 'above') {
      parts.push(
        `the ${zone(rule.zone, rule.zoneName)} goes above ${rule.maxC} °C ${when(temperature.atMs)}`,
      );
    } else if (temperature && rule && rule.minC !== null && rule.maxC !== null) {
      // Both limits and no temperature to tell which: just that it left them.
      parts.push(
        `the ${zone(rule.zone, rule.zoneName)} goes outside ${rule.minC} to ${rule.maxC} °C ${when(temperature.atMs)}`,
      );
    } else {
      const first = broken[0] as (typeof broken)[number];
      parts.push(`the first ${when(first.atMs)}`);
    }
  }
  if (shaky.length > 0) {
    const more = broken.length > 0 ? ' more' : '';
    parts.push(`${shaky.length}${more} might break, depending on the weather`);
  }
  for (const u of unknown) {
    // A sensor is named; anything else (the forecast, the simulation's limit) in its own words.
    const device = u.device ? name(u.device) : undefined;
    parts.push(
      device
        ? `the ${device.toLowerCase()} can’t be trusted`
        : `it can’t confirm everything (${readable(u.text, name)})`,
    );
  }
  if (broken.length === 0 && shaky.length === 0) {
    if (unknown.length > 0) parts.push('no house rule breaks in its run');
    else {
      // A SAFE run: every rule holds, and where a room's temperature is kept, it stays within it.
      const kept = Object.values(run.temperatureRules).find(
        (r) => within(r) !== null && run.trace?.zonesC.nominal[r.zone],
      );
      parts.push(
        kept
          ? `every house rule holds, and the ${zone(kept.zone, kept.zoneName)} stays ${within(kept)}`
          : 'every house rule holds',
      );
    }
  }
  return `${run.label}: ${parts.join('; ')}.`;
}
