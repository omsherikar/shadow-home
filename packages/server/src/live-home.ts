import { type Frame, simulate } from '@shadow-home/engine';
import { type Home, type HomeMode, own, type Plan, type Value } from '@shadow-home/twin';
import type {
  LiveState,
  LogChange,
  LogEntry,
  ScheduledWrite,
  UndoExtras,
  UndoInfo,
} from './store.ts';
import { floorToMinute, isoAt } from './time.ts';

const MINUTE_MS = 60_000;
/** One sync simulates at most this far; a server idle for longer catches up over several calls. */
const MAX_SYNC_MS = 7 * 24 * 60 * MINUTE_MS;

export function initialState(home: Home): LiveState {
  return {
    home: structuredClone(home),
    version: 1,
    syncedToMs: floorToMinute(Date.parse(home.clock.now)),
    pendingModes: [],
  };
}

/**
 * Move the twin forward to `nowMs` with the nominal simulation: routines fire, scheduled writes
 * run, temperatures drift. Returns log entries for what fired. Thermostats start each sync
 * not heating; within the hysteresis band that can delay heating by a few minutes, which is fine
 * for a live view but is why verdicts come from the engine's own runs, never from this state.
 */
export function sync(state: LiveState, nowMs: number): LogEntry[] {
  const target = Math.min(floorToMinute(nowMs), state.syncedToMs + MAX_SYNC_MS);
  if (target <= state.syncedToMs) return [];
  const home = state.home;
  const start = state.syncedToMs;
  const offset = home.home.utcOffset;
  // Events in the start minute already ran in the previous sync: start "now" a minute later.
  const plan: Plan = { context: { now: isoAt(start + MINUTE_MS, offset) }, actions: [] };
  let last: Frame | undefined;
  const result = simulate(
    home,
    plan,
    'nominal',
    { startMs: start, endMs: target, unknowns: [] },
    (f) => {
      last = f;
    },
  );
  if (last) {
    for (const device of home.devices) {
      const now = last.devices.get(device.id);
      if (now) device.state = { ...now };
    }
  }

  const entries: LogEntry[] = [];
  const bySourceMinute = new Map<string, LogEntry>();
  for (const c of result.changes) {
    const key = `${c.source}\u0000${c.atMs}`;
    let entry = bySourceMinute.get(key);
    if (!entry) {
      const routine = home.routines.find((r) => r.id === c.source);
      const queuedBy = c.source.startsWith('plan:') ? c.source.slice('plan:'.length) : undefined;
      entry = {
        id: `log_${c.source.replace(/[^\w-]/g, '_')}_${c.atMs}`,
        at: isoAt(c.atMs, offset),
        who: routine?.owner ?? 'home',
        source: routine ? 'routine' : 'scheduled',
        what: routine ? routine.name : 'a scheduled change',
        ...(routine ? { cause: routine.id } : queuedBy ? { cause: queuedBy } : {}),
        changes: [],
      };
      bySourceMinute.set(key, entry);
      entries.push(entry);
    }
    entry.changes.push({ target: c.device, attr: c.attr, from: c.from ?? null, to: c.to });
  }

  for (const pending of state.pendingModes.filter((m) => m.atMs <= target)) {
    if (home.mode !== pending.mode) {
      entries.push({
        id: `log_mode_${pending.atMs}`,
        at: isoAt(pending.atMs, offset),
        who: 'home',
        source: 'scheduled',
        what: 'a scheduled change',
        cause: pending.source,
        changes: [{ target: 'home', attr: 'mode', from: home.mode, to: pending.mode }],
      });
      home.mode = pending.mode;
    }
  }
  state.pendingModes = state.pendingModes.filter((m) => m.atMs > target);
  home.scheduled = (home.scheduled ?? []).filter((w) => floorToMinute(Date.parse(w.at)) > target);
  for (const r of home.routines) {
    if (r.pausedUntil && Date.parse(r.pausedUntil) <= target) delete r.pausedUntil;
  }
  if (entries.length > 0) state.version++;
  state.syncedToMs = target;
  return entries;
}

/** The home as the engine should see it at `nowMs`, with an undo's extra steps applied. */
export function snapshot(state: LiveState, nowMs: number, extras?: UndoExtras): Home {
  const home = structuredClone(state.home);
  home.clock.now = isoAt(nowMs, home.home.utcOffset);
  if (extras) applyExtras(home, extras);
  return home;
}

function sameWrite(a: ScheduledWrite, b: ScheduledWrite): boolean {
  return (
    a.device === b.device &&
    a.at === b.at &&
    a.source === b.source &&
    JSON.stringify(a.set) === JSON.stringify(b.set)
  );
}

function applyExtras(home: Home, extras: UndoExtras): void {
  home.scheduled = (home.scheduled ?? []).filter(
    (w) => !extras.cancel.some((c) => sameWrite(w, c)),
  );
  for (const p of extras.pauses) {
    const routine = home.routines.find((r) => r.id === p.routine);
    if (!routine) continue;
    if (p.pausedUntil === null) delete routine.pausedUntil;
    else routine.pausedUntil = p.pausedUntil;
  }
}

/** Apply a checked plan to the live home. Returns what changed, for the log and for undo. */
export function applyPlan(
  state: LiveState,
  plan: Plan,
  nowMs: number,
  logId: string,
  extras?: UndoExtras,
): { applied: LogChange[]; held: LogChange[]; undo: UndoInfo } {
  const home = state.home;
  const nowMinute = floorToMinute(nowMs);
  const devices = new Map(home.devices.map((d) => [d.id, d]));
  const undo: UndoInfo = { writes: [], scheduled: [], pauses: [], irreversible: [] };
  const changes: LogChange[] = [];
  const held: LogChange[] = [];
  const source = `plan:${logId}`;

  if (extras) {
    for (const c of extras.cancel) {
      changes.push({ target: c.device, attr: 'scheduled', from: c.at, to: 'cancelled' });
    }
    for (const p of extras.pauses) {
      const before = home.routines.find((r) => r.id === p.routine)?.pausedUntil ?? null;
      changes.push({
        target: p.routine,
        attr: 'pausedUntil',
        from: before,
        to: p.pausedUntil ?? 'none',
      });
    }
    applyExtras(home, extras);
  }

  for (const action of plan.actions) {
    if ('set' in action) {
      const targets = 'group' in action ? (own(home.groups, action.group) ?? []) : [action.device];
      const atMs = action.at ? floorToMinute(Date.parse(action.at)) : nowMinute;
      for (const id of targets) {
        const device = devices.get(id);
        if (!device) continue;
        if (atMs > nowMinute && action.at) {
          const write: ScheduledWrite = {
            device: id,
            set: { ...action.set },
            at: action.at,
            source,
          };
          home.scheduled = [...(home.scheduled ?? []), write];
          undo.scheduled.push(write);
          for (const [attr, value] of Object.entries(action.set)) {
            held.push({ target: id, attr, from: own(device.state, attr) ?? null, to: value });
          }
          continue;
        }
        for (const [attr, value] of Object.entries(action.set)) {
          const from: Value | null = own(device.state, attr) ?? null;
          if (from === value) continue;
          device.state[attr] = value;
          undo.writes.push({ device: id, attr, from, to: value });
          changes.push({ target: id, attr, from, to: value });
          if (device.irreversible?.includes(attr)) undo.irreversible.push({ device: id, attr });
        }
      }
    } else if ('routine' in action) {
      const routine = home.routines.find((r) => r.id === action.routine);
      if (!routine) continue;
      const before = routine.pausedUntil ?? null;
      routine.pausedUntil = action.pauseUntil;
      undo.pauses.push({ routine: routine.id, before, after: action.pauseUntil });
      changes.push({
        target: routine.id,
        attr: 'pausedUntil',
        from: before,
        to: action.pauseUntil,
      });
    } else {
      const mode = action.mode as HomeMode;
      const atMs = action.at ? floorToMinute(Date.parse(action.at)) : nowMinute;
      if (atMs > nowMinute) {
        state.pendingModes.push({ atMs, mode, source: logId });
      } else if (home.mode !== mode) {
        undo.mode = { before: home.mode, after: mode };
        changes.push({ target: 'home', attr: 'mode', from: home.mode, to: mode });
        home.mode = mode;
      }
    }
  }
  state.version++;
  return { applied: changes, held, undo };
}
