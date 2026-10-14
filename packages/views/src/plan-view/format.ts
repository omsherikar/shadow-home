import type { Value } from './types.ts';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/**
 * "Sat 10:37 PM". Times from the server carry the home's UTC offset, so the digits are already
 * the home's wall clock: read them as written, whatever time zone the screen is in.
 */
export function clock(iso: string): string {
  const m = ISO_LOCAL.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const day = DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  const pad = String(mi).padStart(2, '0');
  return `${day} ${h % 12 || 12}:${pad} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "now" for the minute the check started, otherwise the clock time. */
export function when(iso: string, nowIso: string): string {
  return sameMinute(iso, nowIso) ? 'now' : clock(iso);
}

export function sameMinute(a: string, b: string): boolean {
  return Math.floor(Date.parse(a) / 60_000) === Math.floor(Date.parse(b) / 60_000);
}

/** Local midnights strictly inside (start, end], labelled with the day they begin. */
export function midnights(startIso: string, endIso: string): { atMs: number; label: string }[] {
  const m = ISO_LOCAL.exec(startIso);
  const offset = /([+-]\d{2}:\d{2}|Z)$/.exec(startIso)?.[1];
  if (!m || !offset) return [];
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const out: { atMs: number; label: string }[] = [];
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  for (let i = 0; i < 14; i++) {
    day.setUTCDate(day.getUTCDate() + 1);
    const date = day.toISOString().slice(0, 10);
    const atMs = Date.parse(`${date}T00:00:00${offset}`);
    if (atMs > endMs) break;
    if (atMs > startMs) out.push({ atMs, label: DAYS[day.getUTCDay()] ?? date });
  }
  return out;
}

/** How a value reads after a device name: "on", "locked", "20 °C", "paused until Sun 6:00 PM". */
export function valuePhrase(attr: string, v: Value | null): string {
  if (v === null) return 'not set';
  switch (attr) {
    case 'onOff':
      return v ? 'on' : 'off';
    case 'lockState':
      return v === 'UNLOCKED' ? 'unlocked' : 'locked';
    case 'enabled':
      return v ? 'on' : 'off';
    case 'heatingSetpointC':
      return `${String(v)} °C`;
    case 'brightness':
      return `${String(v)}%`;
    case 'systemMode':
      return v === 'off' ? 'heating off' : v === 'heat' ? 'heating on' : String(v);
    case 'pausedUntil':
      return typeof v === 'string' ? `paused until ${clock(v)}` : 'paused';
    default:
      return `${attr} ${String(v)}`;
  }
}

/** One change as a short phrase: "TV off", "Thermostat 20 → 10 °C", "Away mode". */
export function changePhrase(name: string, attr: string, from: Value | null, to: Value): string {
  if (attr === 'mode') return `${capitalise(String(to))} mode`;
  if ((attr === 'heatingSetpointC' || attr === 'brightness') && typeof from === 'number') {
    return `${name} ${from} → ${valuePhrase(attr, to)}`;
  }
  return `${name} ${valuePhrase(attr, to)}`;
}

/**
 * A device's name without its room, for a row that already names the room:
 * "Living room lights" in the Living room is "Lights".
 */
export function shortName(name: string, room: string): string {
  const prefix = `${room.toLowerCase()} `;
  if (room && name.toLowerCase().startsWith(prefix) && name.length > prefix.length) {
    return capitalise(name.slice(prefix.length));
  }
  return name;
}

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
