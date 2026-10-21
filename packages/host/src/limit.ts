const HOUR_MS = 60 * 60 * 1000;

/**
 * At most `max` in any rolling hour, on this instance: uses, or characters of speech. Each call
 * asks to spend `amount` (one use by default) and says whether it may; a refused amount isn't
 * counted, and one larger than the whole budget, or not a positive number, is always refused.
 * `fits` says whether an amount would be spent, without spending it; `retryAfter` says in how many
 * milliseconds it would be (0 now, Infinity never), as the oldest spending leaves the hour.
 */
export function hourlyBudget(
  max: number,
  now: () => number = Date.now,
): ((amount?: number) => boolean) & {
  fits(amount?: number): boolean;
  retryAfter(amount?: number): number;
} {
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
  const retryAfter = (amount = 1) => {
    const t = now();
    if (fits(amount, t)) return 0;
    if (!(amount > 0 && amount <= max)) return Number.POSITIVE_INFINITY;
    // The oldest spending leaves first: wait until enough of it has.
    let left = total;
    for (const { at, amount: spentAmount } of spent) {
      left -= spentAmount;
      if (left + amount <= max) return at + HOUR_MS - t;
    }
    return Number.POSITIVE_INFINITY;
  };
  return Object.assign(spend, { fits: (amount = 1) => fits(amount), retryAfter });
}

/**
 * At most `max` uses in any rolling hour, on this instance. Each call asks for one use and says
 * whether it's allowed; a refused use isn't counted. It bounds what a public endpoint can spend on
 * the model behind it: instances are capped too, so the worst hour is known.
 */
export function hourlyLimit(max: number, now: () => number = Date.now): () => boolean {
  const spend = hourlyBudget(max, now);
  return () => spend();
}

/**
 * An hourly budget for each visitor (any key, such as an address), so one visitor can't spend
 * the hour for everyone. Made-up keys can't grow memory without bound: a visitor idle for an hour
 * is forgotten (their budget is whole again by then), and past `maxVisitors` the longest idle goes
 * first. `fits` says whether a visitor's amount would be spent, without spending it, and
 * `retryAfter` in how many milliseconds it would be; `visitors` says how many are kept.
 */
export function perVisitor(
  max: number,
  options: { maxVisitors?: number; now?: () => number } = {},
): ((visitor: string, amount?: number) => boolean) & {
  fits(visitor: string, amount?: number): boolean;
  retryAfter(visitor: string, amount?: number): number;
  readonly visitors: number;
} {
  const now = options.now ?? Date.now;
  const maxVisitors = options.maxVisitors ?? 10_000;
  // A Map keeps insertion order; each visitor is put back at the end when they ask, so the
  // longest idle is always first.
  const kept = new Map<string, { spend: ReturnType<typeof hourlyBudget>; lastAt: number }>();
  const spend = (visitor: string, amount = 1) => {
    const t = now();
    for (const [key, v] of kept) {
      if (v.lastAt > t - HOUR_MS) break;
      kept.delete(key);
    }
    let v = kept.get(visitor);
    if (v) kept.delete(visitor);
    else {
      if (kept.size >= maxVisitors) kept.delete(kept.keys().next().value as string);
      v = { spend: hourlyBudget(max, now), lastAt: t };
    }
    v.lastAt = t;
    kept.set(visitor, v);
    return v.spend(amount);
  };
  // Someone not kept has a whole budget.
  const fits = (visitor: string, amount = 1) =>
    kept.get(visitor)?.spend.fits(amount) ?? (amount > 0 && amount <= max);
  const retryAfter = (visitor: string, amount = 1) =>
    kept.get(visitor)?.spend.retryAfter(amount) ??
    (amount > 0 && amount <= max ? 0 : Number.POSITIVE_INFINITY);
  return Object.defineProperty(Object.assign(spend, { fits, retryAfter }), 'visitors', {
    get: () => kept.size,
  }) as typeof spend & {
    fits: typeof fits;
    retryAfter: typeof retryAfter;
    readonly visitors: number;
  };
}

/**
 * A cap for everyone on this instance (`total`) and one for each visitor (`each`), spent together:
 * a use is spent from both or from neither, so a visitor retrying while everyone's hour is used up
 * isn't charged for it, and what a visitor's own cap refuses doesn't count against everyone's.
 * Says which refused, the visitor's first, or 'ok'. `retryAfter` says in how many milliseconds
 * both caps would allow a visitor's amount (Infinity: never), so a refusal can say when to come
 * back.
 */
export function hourlyCaps(
  total: number,
  each: number,
  options: { maxVisitors?: number; now?: () => number } = {},
): ((visitor: string, amount?: number) => 'ok' | 'visitor' | 'instance') & {
  retryAfter(visitor: string, amount?: number): number;
} {
  const everyone = hourlyBudget(total, options.now);
  const visitors = perVisitor(each, options);
  const caps = (visitor: string, amount = 1) => {
    if (!visitors.fits(visitor, amount)) return 'visitor' as const;
    if (!everyone(amount)) return 'instance' as const;
    visitors(visitor, amount);
    return 'ok' as const;
  };
  return Object.assign(caps, {
    retryAfter: (visitor: string, amount = 1) =>
      Math.max(visitors.retryAfter(visitor, amount), everyone.retryAfter(amount)),
  });
}

/** A whole number from the environment, or the default when it's unset or not one. */
export function perHour(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= 0 && process.env[name] !== '' ? n : fallback;
}
