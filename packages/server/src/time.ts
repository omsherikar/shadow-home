const MINUTE_MS = 60_000;

export function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** An instant as local ISO time in the home's offset: "2027-01-15T17:45:00-06:00". */
export function isoAt(ms: number, utcOffset: string): string {
  const sign = utcOffset.startsWith('-') ? -1 : 1;
  const [h = 0, m = 0] = utcOffset.slice(1).split(':').map(Number);
  const local = new Date(ms + sign * (h * 60 + m) * MINUTE_MS);
  return `${local.toISOString().slice(0, 19)}${utcOffset}`;
}
