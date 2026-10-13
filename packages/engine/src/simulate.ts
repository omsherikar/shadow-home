import { type Home, own, type Plan, type PresenceSpec, type Value } from '@shadow-home/twin';
import { commandKey, type Frame } from './conditions.ts';
import { forecastSeries, interpolate } from './forecast.ts';
import type { Horizon } from './horizon.ts';
import { clockMinutes, localMinuteOfDay, offsetMinutes, toMs } from './time.ts';
import { expandWrites } from './writes.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export type RunName = 'nominal' | 'pessimistic' | 'optimistic';
export const RUN_NAMES: readonly RunName[] = ['nominal', 'pessimistic', 'optimistic'];

/** A state change the simulation applied. `source` is "plan" or the routine's ID. */
export interface Change {
  atMs: number;
  source: string;
  /** Plan action that caused it, when source is "plan". */
  actionIndex?: number;
  /** Device ID, or "home" for a mode change. */
  device: string;
  attr: string;
  from: Value | undefined;
  to: Value;
}

export interface SimResult {
  changes: Change[];
  /** Steps where routines tried more than loopGuardActionsPerStep actions; the rest were dropped. */
  loopGuardTrippedAt: number[];
}

interface Event {
  atMs: number;
  /** 0 for routine steps, 1 for plan actions: in one minute the routine runs first, the plan wins. */
  rank: 0 | 1;
  seq: number;
  source: string;
  actionIndex?: number;
  device: string;
  attr: string;
  value: Value;
}

/**
 * Step the home one minute at a time through the horizon, calling `onFrame` with the state at
 * each step (after that minute's events, before its heat flows). The frame is reused between
 * calls; copy anything you keep.
 *
 * Per zone and minute: T' = T + (P_heat + gains + Σ UA_couple·(T_other − T) − UA_out·(T − T_out))·60/C.
 * Thermostats are bang-bang: heat below setpoint − hysteresis, stop above setpoint + hysteresis.
 */
export function simulate(
  home: Home,
  plan: Plan,
  run: RunName,
  horizon: Horizon,
  onFrame: (frame: Frame) => void,
): SimResult {
  const params = home.simulation.runs[run];
  const offset = offsetMinutes(home.home.utcOffset);
  const nowMs = toMs(plan.context.now);
  const overrides = plan.context.stateOverrides ?? {};
  const hysteresis = home.simulation.thermostatHysteresisC;

  const devices = new Map<string, Record<string, Value>>(
    home.devices.map((d) => [d.id, { ...d.state, ...own(overrides, d.id)?.state }]),
  );
  const zoneTempC: Record<string, number> = {};
  const heating: Record<string, boolean> = {};
  for (const zone of home.zones) {
    const reading = devices.get(zone.heater.thermostat)?.localTemperatureC;
    zoneTempC[zone.id] = typeof reading === 'number' ? reading : zone.initialTempC;
    heating[zone.id] = false;
  }

  const events = [...planEvents(home, plan), ...routineEvents(home, plan, nowMs, horizon, offset)];
  events.sort((a, b) => a.atMs - b.atMs || a.rank - b.rank || a.seq - b.seq);

  const changes: Change[] = [];
  const loopGuardTrippedAt: number[] = [];
  const commanded = new Set<string>();
  const frame: Frame = {
    ms: horizon.startMs,
    localMinute: 0,
    devices,
    presence: {},
    zoneTempC,
    commanded,
  };
  const forecast = forecastSeries(home);
  const forecastStart = forecast.ms[0] ?? horizon.startMs;
  const forecastEnd = forecast.ms[forecast.ms.length - 1] ?? horizon.endMs;
  const presence = presenceTimeline(home, plan);
  let next = 0;

  for (let ms = horizon.startMs; ms <= horizon.endMs; ms += MINUTE_MS) {
    let routineActions = 0;
    let tripped = false;
    while (next < events.length && (events[next]?.atMs ?? Number.POSITIVE_INFINITY) <= ms) {
      const e = events[next++] as Event;
      if (e.rank === 0 && ++routineActions > home.simulation.loopGuardActionsPerStep) {
        tripped = true;
        continue;
      }
      const state = e.device === 'home' ? undefined : devices.get(e.device);
      if (state) commanded.add(commandKey(e.device, e.attr));
      const from = e.device === 'home' ? homeMode(changes, home) : state?.[e.attr];
      if (from === e.value) continue;
      if (state) state[e.attr] = e.value;
      changes.push({
        atMs: ms,
        source: e.source,
        ...(e.actionIndex === undefined ? {} : { actionIndex: e.actionIndex }),
        device: e.device,
        attr: e.attr,
        from,
        to: e.value,
      });
    }
    if (tripped) loopGuardTrippedAt.push(ms);

    for (const zone of home.zones) {
      const thermostat = devices.get(zone.heater.thermostat);
      const t = zoneTempC[zone.id] ?? zone.initialTempC;
      const setpoint = thermostat?.heatingSetpointC;
      if (thermostat?.systemMode !== 'heat' || typeof setpoint !== 'number') {
        heating[zone.id] = false;
      } else if (t < setpoint - hysteresis) {
        heating[zone.id] = true;
      } else if (t > setpoint + hysteresis) {
        heating[zone.id] = false;
      }
      if (thermostat) thermostat.localTemperatureC = t;
    }

    frame.ms = ms;
    frame.localMinute = localMinuteOfDay(ms, offset);
    frame.presence = presence(ms);
    onFrame(frame);

    if (ms === horizon.endMs) break;
    // Outside the forecast (already reported as unknown by the horizon), hold the nearest point.
    const clamped = Math.min(Math.max(ms, forecastStart), forecastEnd);
    const outdoorC = (interpolate(forecast, clamped) ?? 0) + params.forecastOffsetC;
    const nextTemp: Record<string, number> = {};
    for (const zone of home.zones) {
      const t = zoneTempC[zone.id] ?? zone.initialTempC;
      let watts = heating[zone.id] ? zone.heater.maxPowerW : 0;
      for (const g of home.internalGains) {
        if (g.zone === zone.id && devices.get(g.device)?.onOff === true) watts += g.wattsWhenOn;
      }
      for (const c of home.couplings) {
        const [a, b] = c.zones;
        const other = a === zone.id ? b : b === zone.id ? a : undefined;
        if (other !== undefined) watts += c.uaWPerK * ((zoneTempC[other] ?? t) - t);
      }
      watts -= zone.uaOutWPerK * params.uaMultiplier * (t - outdoorC);
      nextTemp[zone.id] = t + (watts * (MINUTE_MS / 1000)) / zone.heatCapacityJPerK;
    }
    Object.assign(zoneTempC, nextTemp);
  }

  return { changes, loopGuardTrippedAt };
}

function planEvents(home: Home, plan: Plan): Event[] {
  const events: Event[] = expandWrites(home, plan).map((w, seq) => ({
    atMs: w.atMs,
    rank: 1,
    seq,
    source: 'plan',
    actionIndex: w.actionIndex,
    device: w.device,
    attr: w.attr,
    value: w.value,
  }));
  const nowMs = toMs(plan.context.now);
  plan.actions.forEach((a, actionIndex) => {
    if (!('mode' in a)) return;
    events.push({
      atMs: Math.floor((a.at ? toMs(a.at) : nowMs) / MINUTE_MS) * MINUTE_MS,
      rank: 1,
      seq: events.length,
      source: 'plan',
      actionIndex,
      device: 'home',
      attr: 'mode',
      value: a.mode,
    });
  });
  return events;
}

/**
 * Every routine step inside the horizon. Steps before `now` already happened. A pause stops
 * triggers inside [now, pauseUntil); the last pause of a routine in plan order wins. Steps of a
 * run that triggered before now still happen.
 */
function routineEvents(
  home: Home,
  plan: Plan,
  nowMs: number,
  horizon: Horizon,
  offset: number,
): Event[] {
  const pausedUntil = new Map<string, number>();
  for (const a of plan.actions) {
    if ('routine' in a) pausedUntil.set(a.routine, toMs(a.pauseUntil));
  }
  const offsetMs = offset * MINUTE_MS;
  const events: Event[] = [];
  let seq = 0;
  for (const routine of home.routines) {
    if (!routine.enabled) continue;
    const longest = Math.max(0, ...routine.actions.map((s) => s.afterMinutes ?? 0)) * MINUTE_MS;
    const firstDay = Math.floor((horizon.startMs - longest + offsetMs) / DAY_MS) - 1;
    const lastDay = Math.floor((horizon.endMs + offsetMs) / DAY_MS) + 1;
    for (let day = firstDay; day <= lastDay; day++) {
      const triggerMs = day * DAY_MS - offsetMs + clockMinutes(routine.trigger.at) * MINUTE_MS;
      const pause = pausedUntil.get(routine.id);
      if (pause !== undefined && triggerMs >= nowMs && triggerMs < pause) continue;
      for (const step of routine.actions) {
        const atMs = triggerMs + (step.afterMinutes ?? 0) * MINUTE_MS;
        if (atMs < nowMs || atMs > horizon.endMs) continue;
        const targets = 'device' in step ? [step.device] : (own(home.groups, step.group) ?? []);
        for (const device of targets) {
          for (const [attr, value] of Object.entries(step.set)) {
            events.push({ atMs, rank: 0, seq: seq++, source: routine.id, device, attr, value });
          }
        }
      }
    }
  }
  return events;
}

/** Who is home at each instant: the last presence window covering it wins. Parsed once. */
function presenceTimeline(home: Home, plan: Plan): (ms: number) => Record<string, 'home' | 'away'> {
  const windows = (plan.context.presenceSchedule ?? []).map((w) => ({
    fromMs: toMs(w.from),
    toMs: toMs(w.to),
    spec: w.presence,
  }));
  return (ms) => {
    let spec: PresenceSpec | undefined;
    for (const w of windows) if (w.fromMs <= ms && ms < w.toMs) spec = w.spec;
    const out: Record<string, 'home' | 'away'> = {};
    for (const m of home.household.members) {
      if (spec === undefined) out[m.id] = own(home.household.presence, m.id) ?? 'away';
      else if (spec === 'nobody') out[m.id] = 'away';
      else if (spec === 'everyone') out[m.id] = 'home';
      else out[m.id] = spec.home.includes(m.id) ? 'home' : 'away';
    }
    return out;
  };
}

function homeMode(changes: Change[], home: Home): Value {
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    if (c?.device === 'home' && c.attr === 'mode') return c.to;
  }
  return home.mode;
}
