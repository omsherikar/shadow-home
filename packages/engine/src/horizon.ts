import type { Home, Plan } from '@shadow-home/twin';
import { forecastSpan } from './forecast.ts';
import { floorToMinute, formatIso, offsetMinutes, toMs } from './time.ts';

const HOUR_MS = 60 * 60_000;

export interface Horizon {
  startMs: number;
  endMs: number;
  /** Why part of the plan can't be simulated. Any entry makes the verdict UNPROVEN. */
  unknowns: string[];
}

/**
 * The stretch of time to simulate: from `now` to the latest of `planEnd`, 12 h after the last
 * action, the end of the last presence window, the end of the last routine pause (the plan's
 * effects last that long) and the last write an earlier plan scheduled, capped at the maximum horizon and at the end of the forecast. Any
 * cut is reported as an unknown, so a plan the engine can't see to the end is never SAFE.
 */
export function computeHorizon(home: Home, plan: Plan): Horizon {
  const { maxHorizonHours, horizonAfterLastActionHours } = home.simulation;
  const offset = offsetMinutes(home.home.utcOffset);
  const startMs = floorToMinute(toMs(plan.context.now));
  const actionTimes = plan.actions.map((a) =>
    'at' in a && a.at ? floorToMinute(toMs(a.at)) : startMs,
  );
  const lastActionMs = Math.max(startMs, ...actionTimes);
  const planEndMs = plan.context.planEnd ? toMs(plan.context.planEnd) : 0;
  const windowEnds = (plan.context.presenceSchedule ?? []).map((w) => toMs(w.to));
  const pauseEnds = plan.actions.flatMap((a) => ('routine' in a ? [toMs(a.pauseUntil)] : []));
  // Writes an earlier plan scheduled can interact with this one, so they are seen through too.
  const scheduled = (home.scheduled ?? []).map((w) => floorToMinute(toMs(w.at)));
  const wanted = Math.max(
    planEndMs,
    lastActionMs + horizonAfterLastActionHours * HOUR_MS,
    ...windowEnds,
    ...pauseEnds,
    ...scheduled.filter((ms) => ms >= startMs),
  );

  const forecast = forecastSpan(home);
  const unknowns: string[] = [];
  if (startMs < forecast.startMs) {
    unknowns.push(`no forecast before ${formatIso(forecast.startMs, offset)}`);
  }
  const capMs = startMs + maxHorizonHours * HOUR_MS;
  const endMs = Math.min(wanted, capMs, forecast.endMs);
  if (wanted > endMs) {
    unknowns.push(
      endMs === forecast.endMs
        ? `no forecast after ${formatIso(forecast.endMs, offset)}`
        : `the plan runs to ${formatIso(wanted, offset)}, past the ${maxHorizonHours}-hour limit of the simulation`,
    );
  }
  actionTimes.forEach((ms, i) => {
    if (ms > endMs) {
      const at = formatIso(ms, offset);
      unknowns.push(`action ${i} at ${at} is past the end of the simulation`);
    }
  });
  return { startMs, endMs, unknowns };
}
