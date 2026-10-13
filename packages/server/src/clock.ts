/**
 * Two clocks. Home time drives the twin: routines, scheduled writes, plan times. Wall time
 * drives plan ID expiry. Running locally, home time starts at the fixture's clock and moves at
 * real speed; tests and the scripted demo move it by hand.
 */
export interface Clock {
  homeNowMs(): number;
  wallNowMs(): number;
}

export interface ManualClock extends Clock {
  /** Move both clocks forward. */
  advance(ms: number): void;
  /** Jump home time (the demo's "Sunday evening"); wall time is unchanged. */
  setHomeNow(ms: number): void;
}

export function systemClock(homeStartMs: number, wallNow: () => number = Date.now): Clock {
  const wallStart = wallNow();
  return {
    homeNowMs: () => homeStartMs + (wallNow() - wallStart),
    wallNowMs: wallNow,
  };
}

export function manualClock(homeStartMs: number, wallStartMs = 0): ManualClock {
  let home = homeStartMs;
  let wall = wallStartMs;
  return {
    homeNowMs: () => home,
    wallNowMs: () => wall,
    advance(ms) {
      home += ms;
      wall += ms;
    },
    setHomeNow(ms) {
      home = ms;
    },
  };
}
