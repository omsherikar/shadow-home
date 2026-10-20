const HOUR_MS = 60 * 60 * 1000;

/**
 * At most `max` in any rolling hour, on this instance: uses, or characters of speech. Each call
 * asks to spend `amount` (one use by default) and says whether it may; a refused amount isn't
 * counted, and one larger than the whole budget, or not a positive number, is always refused.
 * `fits` says whether an amount would be spent, without spending it.
 */
export function hourlyBudget(
  max: number,
  now: () => number = Date.now,
): ((amount?: number) => boolean) & { fits(amount?: number): boolean } {
  const spent: { at: number; amount: number }[] = [];
  let total = 0;
  const fits = (amount = 1, t = now()) => {
    while (spent.length > 0 && (spent[0] as { at: number }).at <= t - HOUR_MS) {
      total -= (spent.shift() as { amount: number }).amount;
    }
    return amount > 0 && total + amount <= max;
  };
  const spend = (amount = 1) => {
    const t = now();
    if (!fits(amount, t)) return false;
    spent.push({ at: t, amount });
    total += amount;
    return true;
  };
  return Object.assign(spend, { fits: (amount = 1) => fits(amount) });
}

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
