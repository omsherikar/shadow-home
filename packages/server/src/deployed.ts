// What every deployed server starts from, on AWS or Google Cloud: the demo home, checked, and the
// daily clock that starts it over each day under a new key.
import { type Home, homeSchema, validateHome } from '@shadow-home/twin';
import fixture from '../../../fixtures/demo-home.json' with { type: 'json' };
import { type DailyClock, dailyClock } from './clock.ts';
import { initialState } from './live-home.ts';
import type { LiveState } from './store.ts';

const DAY_MS = 24 * 60 * 60_000;

export interface DeployedHome {
  home: Home;
  clock: DailyClock;
  /** The current day's home, for the store to keep apart from other days. */
  homeKey: () => string;
  initial: () => LiveState;
  /** When a day's stored home may be deleted, in epoch milliseconds: two days after it ends. */
  expiresAtMs: () => number;
}

/** The demo home and its clock. HOME_RESTART_HOUR: the UTC hour it starts over (default 8). */
export function deployedHome(): DeployedHome {
  const home = homeSchema.parse(fixture);
  const problems = validateHome(home);
  if (problems.length > 0) throw new Error(`The demo home is inconsistent: ${problems.join('; ')}`);
  const clock = dailyClock(Date.parse(home.clock.now), Number(process.env.HOME_RESTART_HOUR ?? 8));
  return {
    home,
    clock,
    homeKey: () => `home#${clock.run()}`,
    initial: () => initialState(home),
    expiresAtMs: () => clock.wallNowMs() + 3 * DAY_MS,
  };
}
