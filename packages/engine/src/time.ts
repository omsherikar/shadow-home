// Time helpers. Every instant comes from the plan or the home; nothing reads the clock.

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

/** Epoch milliseconds for an ISO date-time with an offset (already validated by the schema). */
export function toMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`not a date-time: ${iso}`);
  return ms;
}

/** The start of the minute containing `ms`: the simulation step an instant falls in. */
export function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** "-06:00" → -360. */
export function offsetMinutes(utcOffset: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(utcOffset);
  if (!m) throw new Error(`not a UTC offset: ${utcOffset}`);
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

/** Minutes since local midnight, 0–1439, for an instant in a home at a fixed UTC offset. */
export function localMinuteOfDay(ms: number, utcOffsetMinutes: number): number {
  const local = Math.floor(ms / MINUTE_MS) + utcOffsetMinutes;
  return ((local % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

/** "22:30" → 1350. */
export function clockMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** 1350 → "22:30". */
export function formatClock(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** An instant as ISO 8601 in a fixed UTC offset, e.g. "2027-01-15T17:45:00-06:00". */
export function formatIso(ms: number, utcOffsetMinutes: number): string {
  const local = new Date(ms + utcOffsetMinutes * MINUTE_MS).toISOString().slice(0, 19);
  const sign = utcOffsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(utcOffsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${sign}${hh}:${mm}`;
}
