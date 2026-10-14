const HOUR_MS = 60 * 60 * 1000;

/**
 * At most `max` uses in any rolling hour, on this instance. Each call asks for one use and says
 * whether it's allowed; a refused use isn't counted. It bounds what a public endpoint can spend on
 * the model behind it: instances are capped too, so the worst hour is known.
 */
export function hourlyLimit(max: number, now: () => number = Date.now): () => boolean {
  const used: number[] = [];
  return () => {
    const t = now();
    while (used.length > 0 && (used[0] as number) <= t - HOUR_MS) used.shift();
    if (used.length >= max) return false;
    used.push(t);
    return true;
  };
}

/** A whole number from the environment, or the default when it's unset or not one. */
export function perHour(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= 0 && process.env[name] !== '' ? n : fallback;
}
