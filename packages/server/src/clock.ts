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

/**
 * Home time for the local demo: real speed, but the demo can move it forward to the next scene
 * ("Sunday evening") and back to the start on a reset. Never backwards otherwise: the live twin
 * only moves forward.
 */
export interface DemoClock extends Clock {
  /** Move home time forward to `homeMs`; a time already passed leaves it where it is. */
  jumpTo(homeMs: number): void;
  /** Start again from `homeMs`, with the home reset to match. */
  restart(homeMs: number): void;
}

export function demoClock(homeStartMs: number, wallNow: () => number = Date.now): DemoClock {
  let homeBase = homeStartMs;
  let wallBase = wallNow();
  const homeNowMs = () => homeBase + (wallNow() - wallBase);
  const rebase = (homeMs: number) => {
    homeBase = homeMs;
    wallBase = wallNow();
  };
  return {
    homeNowMs,
    wallNowMs: wallNow,
    jumpTo(homeMs) {
      if (homeMs > homeNowMs()) rebase(homeMs);
    },
    restart: rebase,
  };
}
