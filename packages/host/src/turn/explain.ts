/**
 * Every broken rule of a check in plain words, with what causes it and when: "Coffee at 7 turns
 * the coffee maker on at Sat 7:00 AM, which breaks Om's rule: "No coffee maker running when
 * nobody's home."". Built from the check's own result and the names the server sends for the
 * screen, never from the model, so what Alexa says about a broken rule is always the engine's.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
const NAMES_META_KEY = 'shadow-home/names';
/** At most this many rules are spelled out; the screen lists every one. */
const MOST = 4;

interface Cause {
  at: string;
  source: string;
  device: string;
  attr: string;
  to: unknown;
}

interface Violation {
  rule: string;
  text: string;
  author: string;
  firstAt: string;
  cause?: Cause;
}

interface Names {
  devices?: Record<string, { name?: string }>;
  routines?: Record<string, string>;
  members?: Record<string, string>;
}

/** "Sat 10:37 PM", read from the time as written: it carries the home's own offset. */
function clock(iso: string): string {
  const m = ISO_LOCAL.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const day = DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${day} ${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function sameMinute(a: string, b: string): boolean {
  return Math.floor(Date.parse(a) / 60_000) === Math.floor(Date.parse(b) / 60_000);
}

function lower(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** What the change does to the device: "turns the coffee maker on", "unlocks the front door". */
function doing(device: string, attr: string, to: unknown): string {
  const d = lower(device);
  switch (attr) {
    case 'onOff':
    case 'enabled':
      return `turns the ${d} ${to ? 'on' : 'off'}`;
    case 'systemMode':
      return `turns the ${d}'s heating ${to === 'off' ? 'off' : 'on'}`;
    case 'heatingSetpointC':
      return `sets the ${d} to ${String(to)} °C`;
    case 'lockState':
      return to === 'UNLOCKED' ? `unlocks the ${d}` : `locks the ${d}`;
    case 'brightness':
      return `sets the ${d} to ${String(to)}%`;
    default:
      return `changes the ${d}`;
  }
}

function oneRule(v: Violation, startIso: string | undefined, names: Names): string {
  const author = names.members?.[v.author] ?? capitalise(v.author);
  const rule = `${author}'s rule: "${v.text.replace(/\s+$/, '')}"`;
  const breakNow = startIso !== undefined && sameMinute(v.firstAt, startIso);
  const breakAt = breakNow ? 'right away' : `at ${clock(v.firstAt)}`;
  const c = v.cause;
  const end = /[.!?]"$/.test(rule) ? '' : '.';
  if (!c) return `${capitalise(breakAt)} it breaks ${rule}${end}`;
  const who =
    c.source === 'plan'
      ? 'Your plan'
      : (names.routines?.[c.source] ?? `The ${c.source.replace(/_/g, ' ')} routine`);
  const device = names.devices?.[c.device]?.name ?? c.device.replace(/_/g, ' ');
  const causeNow = startIso !== undefined && sameMinute(c.at, startIso);
  const causeAt = causeNow ? '' : ` at ${clock(c.at)}`;
  if (sameMinute(c.at, v.firstAt)) {
    return `${who} ${doing(device, c.attr, c.to)}${causeAt}, which breaks ${rule}${end}`;
  }
  return `${who} ${doing(device, c.attr, c.to)}${causeAt}, and by ${clock(v.firstAt)} that breaks ${rule}${end}`;
}

/**
 * The broken rules of a check, one sentence each (the most important first, each rule once), or
 * undefined when the result names none.
 */
export function explainBreaks(
  structured: Record<string, unknown> | undefined,
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const all = structured?.violations;
  if (!Array.isArray(all) || all.length === 0) return undefined;
  const seen = new Set<string>();
  const rules: Violation[] = [];
  for (const v of all as Violation[]) {
    if (typeof v?.rule !== 'string' || typeof v.text !== 'string' || seen.has(v.rule)) continue;
    seen.add(v.rule);
    rules.push(v);
  }
  if (rules.length === 0) return undefined;
  const names = ((meta?.[NAMES_META_KEY] ?? {}) as Names) || {};
  const horizon = structured?.horizon as { start?: unknown } | undefined;
  const start = typeof horizon?.start === 'string' ? horizon.start : undefined;
  const said = rules.slice(0, MOST).map((v) => oneRule(v, start, names));
  const more = rules.length - MOST;
  if (more > 0) said.push(`And ${more} more ${more === 1 ? 'rule' : 'rules'} on the screen.`);
  return said.join(' ');
}
