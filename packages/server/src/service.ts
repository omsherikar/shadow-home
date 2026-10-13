import {
  assess,
  type CheckResult,
  check,
  type RuleAtom,
  reversibility,
  ruleAtoms,
  type Speech,
  type TierResult,
  untrustedSensors,
} from '@shadow-home/engine';
import {
  type Home,
  type Plan,
  type PlanAction,
  type Rule,
  ruleSchema,
  type Value,
  validateHome,
} from '@shadow-home/twin';
import type { z } from 'zod';
import type { Clock } from './clock.ts';
import { applyPlan, snapshot, sync } from './live-home.ts';
import { newNonce, signPlanId, verifyPlanId } from './plan-id.ts';
import { readBack } from './read-back.ts';
import type {
  AddRuleOutput,
  ApproveOutput,
  addRuleInput,
  CommitOutput,
  commitInput,
  HomeStateOutput,
  homeStateInput,
  LogOutput,
  logInput,
  PreviewOutput,
  previewInput,
  UndoOutput,
  undoInput,
} from './schemas.ts';
import type {
  LiveState,
  LogEntry,
  PreviewKind,
  PreviewRecord,
  Store,
  UndoExtras,
} from './store.ts';
import { isoAt } from './time.ts';

export interface ServiceOptions {
  store: Store;
  clock: Clock;
  /** HMAC key for plan IDs. */
  secret: string;
  /** How long a plan ID stays valid. Default 5 minutes. */
  previewTtlMs?: number;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * The seven tools' logic, independent of MCP. Calls run one at a time: each first brings the
 * twin up to the current home time, then reads or changes it.
 */
export class ShadowHomeService {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly secret: string;
  private readonly ttlMs: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ServiceOptions) {
    this.store = options.store;
    this.clock = options.clock;
    this.secret = options.secret;
    this.ttlMs = options.previewTtlMs ?? 5 * 60_000;
  }

  getHomeState(input: z.infer<typeof homeStateInput>): Promise<HomeStateOutput> {
    return this.exclusive(async () => {
      const { state, nowMs } = await this.current();
      const home = state.home;
      const iso = (ms: number) => isoAt(ms, home.home.utcOffset);
      const untrusted = untrustedSensors(home, { context: { now: iso(nowMs) }, actions: [] });
      const room = input.room?.toLowerCase();
      const inRoom = (id: string) => {
        if (!room) return true;
        const r = home.rooms.find((x) => x.id === id);
        return r?.id.toLowerCase() === room || r?.name.toLowerCase() === room;
      };
      return {
        now: iso(nowMs),
        mode: home.mode,
        stateVersion: state.version,
        presence: { ...home.household.presence },
        zones: home.zones.map((z) => {
          const reading = home.devices.find((d) => d.id === z.heater.thermostat)?.state
            .localTemperatureC;
          const tempC = typeof reading === 'number' ? reading : z.initialTempC;
          return { id: z.id, name: z.name, tempC: Math.round(tempC * 100) / 100 };
        }),
        devices: home.devices
          .filter((d) => inRoom(d.room))
          .map((d) => {
            const why = untrusted.get(d.id);
            return {
              id: d.id,
              name: d.name,
              room: d.room,
              kind: d.kind,
              state: { ...d.state },
              ...(d.sensor
                ? {
                    sensor: {
                      batteryPercent: d.sensor.batteryPercent,
                      minutesSinceReport: d.sensor.lastReportMinutesAgo,
                      trusted: !why,
                      ...(why ? { why } : {}),
                    },
                  }
                : {}),
            };
          }),
        routines: home.routines.map((r) => ({
          id: r.id,
          name: r.name,
          owner: r.owner,
          enabled: r.enabled,
          at: r.trigger.at,
          ...(r.pausedUntil ? { pausedUntil: r.pausedUntil } : {}),
        })),
        scheduled: (home.scheduled ?? []).map((w) => ({ ...w, set: { ...w.set } })),
      };
    });
  }

  previewPlan(input: z.infer<typeof previewInput>): Promise<PreviewOutput> {
    return this.exclusive(async () => {
      const { state, nowMs } = await this.current();
      const plan: Plan = {
        context: {
          now: isoAt(nowMs, state.home.home.utcOffset),
          ...(input.presenceSchedule ? { presenceSchedule: input.presenceSchedule } : {}),
          ...(input.planEnd ? { planEnd: input.planEnd } : {}),
        },
        actions: input.actions,
      };
      return this.preview(state, nowMs, plan, {
        kind: 'plan',
        intent: input.intent,
        ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
      });
    });
  }

  commitPlan(input: z.infer<typeof commitInput>): Promise<CommitOutput> {
    return this.exclusive(async () => {
      const wallNow = this.clock.wallNowMs();
      const verified = verifyPlanId(this.secret, input.planId, wallNow);
      if (!verified.ok && verified.reason !== 'expired') {
        return refused('tampered', input.planId, "That plan ID isn't one I issued.");
      }
      const prior = await this.store.getCommit(input.planId);
      if (prior && !input.safePartOnly) return prior as CommitOutput;

      let planId = input.planId;
      let record = verified.claims ? await this.store.getPreview(verified.claims.n) : undefined;
      if (!record) return refused('unknown_plan', planId, "I don't have that plan any more.");
      const { state, nowMs } = await this.current();
      if (!verified.ok) {
        return {
          ...refused('expired', planId, 'That preview expired. Here it is again.'),
          freshPreview: await this.fresh(state, nowMs, record),
        };
      }
      let version = verified.claims.v;
      if (input.safePartOnly) {
        const safeId = record.related.safePart;
        if (!safeId)
          return refused('no_safe_part', planId, 'No part of that plan is safe on its own.');
        planId = safeId;
        const priorSafe = await this.store.getCommit(planId);
        if (priorSafe) return priorSafe as CommitOutput;
        const safe = verifyPlanId(this.secret, planId, wallNow);
        record = safe.ok ? await this.store.getPreview(safe.claims.n) : undefined;
        if (!record || !safe.ok)
          return refused('unknown_plan', planId, "I don't have that plan any more.");
        version = safe.claims.v;
      }

      // The home moved on since the preview: the person gets a fresh preview, not a stale yes.
      const stale = async () => ({
        ...refused(
          'state_changed',
          planId,
          'Something changed since the preview. Here it is again.',
        ),
        freshPreview: await this.fresh(state, nowMs, record as PreviewRecord),
      });
      if (version !== state.version) return stale();
      const plan = retime(record.plan, isoAt(nowMs, state.home.home.utcOffset));
      const recheck = check(snapshot(state, nowMs, record.undo), plan);
      if (recheck.verdict !== record.verdict) return stale();

      const alternatives = {
        ...(record.related.repair ? { repairPlanId: record.related.repair } : {}),
        ...(record.related.safePart ? { safePartPlanId: record.related.safePart } : {}),
      };
      if (record.tier === 'T5') {
        return {
          ...refused('refused_by_rule', planId, record.speech.reason ?? "I can't do that."),
          alternatives,
        };
      }
      if (record.tier === 'T3') {
        return {
          ...refused('unsafe', planId, record.speech.reason ?? 'That breaks a house rule.'),
          alternatives,
        };
      }
      if (record.irreversible && record.verdict !== 'SAFE') {
        return refused(
          'irreversible_needs_safe',
          planId,
          "That can't be undone, so it has to be proven safe first.",
        );
      }
      if (record.tier === 'T2' || record.tier === 'T4') {
        const approved = await this.store.getApproval(record.nonce);
        if (!input.confirmed && !approved) {
          return {
            status: 'needs_confirmation',
            planId,
            speech: {
              headline: 'I need a yes first.',
              ...(record.speech.ask ? { ask: record.speech.ask } : {}),
            },
            applied: [],
            held: [],
          };
        }
      }

      const logId = `log_${record.nonce}`;
      const { applied, held, undo } = applyPlan(state, plan, nowMs, logId, record.undo);
      const entry: LogEntry = {
        id: logId,
        at: isoAt(nowMs, state.home.home.utcOffset),
        who: record.requestedBy ?? 'unknown',
        source: record.kind === 'undo' ? 'undo' : 'plan',
        what: record.intent,
        planId,
        verdict: record.verdict,
        tier: record.tier,
        changes: [...applied, ...held],
        undoToken: `undo_${record.nonce}`,
        undo,
      };
      if (record.undo) {
        const original = (await this.store.listLog()).find((e) => e.id === record?.undo?.of);
        if (original) await this.store.putLog({ ...original, undoneBy: logId });
      }
      await this.store.putLog(entry);
      await this.store.saveState(state);
      const result: CommitOutput = {
        status: 'committed',
        planId,
        speech: { headline: committedHeadline(applied.length, held.length) },
        applied,
        held,
        undoToken: entry.undoToken,
        logEntryId: logId,
      };
      await this.store.putCommit(planId, result);
      return result;
    });
  }

  undo(input: z.infer<typeof undoInput>): Promise<UndoOutput> {
    return this.exclusive(async () => {
      const { state, nowMs } = await this.current();
      const home = state.home;
      const log = await this.store.listLog();
      const entry =
        input.token === 'last'
          ? log
              .filter((e) => e.undo && !e.undoneBy && (e.source === 'plan' || e.source === 'undo'))
              .at(-1)
          : log.find((e) => e.undoToken === input.token);
      if (!entry?.undo) return nothingToUndo("There's nothing to undo.");
      if (entry.undoneBy) return nothingToUndo('That was already undone.', entry.id);

      const only = input.devices ? new Set(input.devices) : null;
      const pick = (id: string) => !only || only.has(id);
      const actions: PlanAction[] = [];
      const cannotUndo: UndoOutput['cannotUndo'] = [];
      const notes: string[] = [];

      // Net effect per attribute: the value before the first write, the value after the last.
      const net = new Map<
        string,
        { device: string; attr: string; from: Value | null; to: Value }
      >();
      for (const w of entry.undo.writes) {
        const key = `${w.device}\u0000${w.attr}`;
        const seen = net.get(key);
        if (seen) seen.to = w.to;
        else net.set(key, { ...w });
      }
      for (const w of net.values()) {
        if (!pick(w.device)) continue;
        const device = home.devices.find((d) => d.id === w.device);
        const now = device?.state[w.attr];
        if (entry.undo.irreversible.some((x) => x.device === w.device && x.attr === w.attr)) {
          cannotUndo.push({
            target: w.device,
            attr: w.attr,
            why: "it can't be undone once it has run",
          });
        } else if (now !== w.to) {
          cannotUndo.push({
            target: w.device,
            attr: w.attr,
            why: `it has changed since, to ${String(now)}`,
          });
        } else if (w.from === null) {
          cannotUndo.push({ target: w.device, attr: w.attr, why: 'it had no earlier value' });
        } else {
          actions.push({ device: w.device, set: { [w.attr]: w.from } });
        }
      }
      const mode = entry.undo.mode;
      if (mode && pick('home')) {
        if (home.mode === mode.after) actions.push({ mode: mode.before });
        else
          cannotUndo.push({
            target: 'home',
            attr: 'mode',
            why: `it has changed since, to ${home.mode}`,
          });
      }
      const queued = home.scheduled ?? [];
      const cancel = entry.undo.scheduled.filter(
        (w) => pick(w.device) && queued.some((q) => JSON.stringify(q) === JSON.stringify(w)),
      );
      const pauses = entry.undo.pauses
        .filter((p) => pick(p.routine))
        .filter((p) => home.routines.find((r) => r.id === p.routine)?.pausedUntil === p.after)
        .map((p) => ({ routine: p.routine, pausedUntil: p.before }));
      if (actions.length === 0 && cancel.length === 0 && pauses.length === 0) {
        return { ...nothingToUndo('Nothing from that can be put back.', entry.id), cannotUndo };
      }
      for (const c of cancel) notes.push(`Cancels ${c.device} at ${c.at}; it hasn't run yet.`);
      for (const p of pauses) {
        const name = home.routines.find((r) => r.id === p.routine)?.name ?? p.routine;
        notes.push(p.pausedUntil ? `${name} goes back to its earlier pause.` : `${name} resumes.`);
      }
      if (actions.length > 0) {
        notes.push('Settings go back; what already happened while they were changed stays.');
      }
      const extras: UndoExtras = { of: entry.id, cancel, pauses };
      const plan: Plan = { context: { now: isoAt(nowMs, home.home.utcOffset) }, actions };
      const preview = await this.preview(state, nowMs, plan, {
        kind: 'undo',
        intent: `undo: ${entry.what}`,
        requestedBy: entry.who,
        undo: extras,
      });
      return {
        status: 'preview',
        undoOf: entry.id,
        preview,
        cannotUndo,
        notes,
        speech: preview.speech,
      };
    });
  }

  getActivityLog(input: z.infer<typeof logInput>): Promise<LogOutput> {
    return this.exclusive(async () => {
      const { state } = await this.current();
      const fromMs = input.from ? Date.parse(input.from) : Number.NEGATIVE_INFINITY;
      const toMs = input.to ? Date.parse(input.to) : Number.POSITIVE_INFINITY;
      // Stable sort: entries in the same minute keep the order they were written in.
      const all = (await this.store.listLog()).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const entries = all
        .filter((e) => Date.parse(e.at) >= fromMs && Date.parse(e.at) <= toMs)
        .filter((e) => !input.person || e.who === input.person)
        .map((e) => ({
          id: e.id,
          at: e.at,
          who: e.who,
          source: e.source,
          what: e.what,
          ...(e.cause ? { cause: e.cause } : {}),
          ...(e.verdict ? { verdict: e.verdict } : {}),
          ...(e.tier ? { tier: e.tier } : {}),
          changes: e.changes,
          undoable: Boolean(e.undo) && !e.undoneBy,
          ...(e.undoToken && e.undo && !e.undoneBy ? { undoToken: e.undoToken } : {}),
          ...(e.undoneBy ? { undoneBy: e.undoneBy } : {}),
        }));
      const groups: LogOutput['groups'] = [];
      if (input.groupBy !== 'none') {
        const byKey = new Map<string, LogOutput['groups'][number]>();
        for (const e of entries) {
          const key =
            e.source === 'routine'
              ? `routine:${e.cause}`
              : e.source === 'scheduled' && e.cause
                ? e.cause
                : e.id;
          let g = byKey.get(key);
          if (!g) {
            const routine = state.home.routines.find((r) => `routine:${r.id}` === key);
            const plan = all.find((x) => x.id === key);
            g = { cause: key, label: routine?.name ?? plan?.what ?? e.what, entryIds: [] };
            byKey.set(key, g);
            groups.push(g);
          }
          g.entryIds.push(e.id);
        }
      }
      return { entries, groups };
    });
  }

  addHouseRule(input: z.infer<typeof addRuleInput>): Promise<AddRuleOutput> {
    const compiled = input.rule;
    if (!compiled) {
      return Promise.resolve({
        status: 'needs_compiler',
        problems: ['The rule compiler is not connected; send the compiled rule in `rule`.'],
        conflicts: [],
        needsOwnerApproval: false,
        speech: { headline: "I can't turn that into a rule yet." },
      });
    }
    return this.exclusive(async () => {
      const { state, nowMs } = await this.current();
      const home = state.home;
      const id = `R${Math.max(0, ...home.rules.map((r) => Number(r.id.slice(1)) || 0)) + 1}`;
      const parsed = ruleSchema.safeParse({
        ...compiled,
        id,
        text: input.text,
        author: input.author,
        source: 'add_house_rule',
      });
      const invalid = (problems: string[]): AddRuleOutput => ({
        status: 'invalid',
        problems,
        conflicts: [],
        needsOwnerApproval: false,
        speech: { headline: "That rule doesn't fit this home.", reason: problems[0] ?? '' },
      });
      if (!parsed.success)
        return invalid(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
      const rule = parsed.data;
      const withRule = snapshot(state, nowMs);
      withRule.rules.push(rule);
      const problems = validateHome(withRule).filter((p) => p.startsWith(`rule ${id} `));
      if (problems.length > 0) return invalid(problems);

      const conflicts = findConflicts(home, rule);
      const role = home.household.members.find((m) => m.id === input.author)?.role;
      const needsOwnerApproval =
        role !== 'owner' &&
        conflicts.some(
          (c) => c.winner === id && (c.priority === 'life-safety' || c.priority === 'security'),
        );
      const sample = check(withRule, {
        context: {
          now: isoAt(nowMs, home.home.utcOffset),
          planEnd: isoAt(nowMs + DAY_MS, home.home.utcOffset),
        },
        actions: [],
      });
      const sampleDay = ruleOutcome(sample, id);
      const text = readBack(home, rule);
      if (!needsOwnerApproval) {
        home.rules.push(rule);
        state.version++;
        await this.store.saveState(state);
      }
      const clash = conflicts[0];
      return {
        status: needsOwnerApproval ? 'pending_owner_approval' : 'added',
        ruleId: id,
        readBack: text,
        problems: [],
        conflicts,
        sampleDay,
        needsOwnerApproval,
        speech: {
          headline: needsOwnerApproval ? 'That rule needs the owner to approve it.' : 'Rule added.',
          reason: clash
            ? `It clashes with ${clash.rule}; ${clash.winner === id ? 'the new rule' : clash.rule} wins by priority.`
            : clip(text, 25),
        },
      };
    });
  }

  approvePlan(input: { planId: string }): Promise<ApproveOutput> {
    return this.exclusive(async () => {
      const wallNow = this.clock.wallNowMs();
      const v = verifyPlanId(this.secret, input.planId, wallNow);
      if (!v.ok) {
        return {
          status: 'refused',
          reason: v.reason === 'expired' ? 'expired' : 'tampered',
          planId: input.planId,
        };
      }
      const record = await this.store.getPreview(v.claims.n);
      if (!record) return { status: 'refused', reason: 'unknown_plan', planId: input.planId };
      await this.store.putApproval(record.nonce, { at: wallNow, by: 'screen' });
      return {
        status: 'approved',
        planId: input.planId,
        approvedAt: new Date(wallNow).toISOString(),
      };
    });
  }

  private async preview(
    state: LiveState,
    nowMs: number,
    plan: Plan,
    meta: { kind: PreviewKind; intent: string; requestedBy?: string; undo?: UndoExtras },
  ): Promise<PreviewOutput> {
    const home = snapshot(state, nowMs, meta.undo);
    const options = meta.requestedBy ? { requestedBy: meta.requestedBy } : {};
    const a = assess(home, plan, options);
    const expires = this.clock.wallNowMs() + this.ttlMs;
    const save = async (
      kind: PreviewKind,
      p: Plan,
      c: CheckResult,
      t: TierResult,
      speech: Speech,
      related: PreviewRecord['related'],
    ) => {
      const nonce = newNonce();
      await this.store.putPreview({
        nonce,
        kind,
        plan: p,
        intent: meta.intent,
        ...(meta.requestedBy ? { requestedBy: meta.requestedBy } : {}),
        stateVersion: state.version,
        verdict: c.verdict,
        tier: t.tier,
        speech,
        irreversible: reversibility(home, p).some((x) => x.irreversibleOnceFired),
        related,
        ...(meta.undo ? { undo: meta.undo } : {}),
      });
      return signPlanId(this.secret, { n: nonce, v: state.version, x: expires });
    };
    const altSpeech = (t: TierResult): Speech => ({ headline: `Alternative at ${t.tier}.` });
    const repairId = a.repaired
      ? await save(
          'repair',
          a.repaired.plan,
          a.repaired.check,
          a.repaired.tier,
          altSpeech(a.repaired.tier),
          {},
        )
      : undefined;
    const safeId = a.safePart
      ? await save(
          'safe_part',
          a.safePart.plan,
          a.safePart.check,
          a.safePart.tier,
          altSpeech(a.safePart.tier),
          {},
        )
      : undefined;
    const planId = await save(meta.kind, plan, a.check, a.tier, a.speech, {
      ...(repairId ? { repair: repairId } : {}),
      ...(safeId ? { safePart: safeId } : {}),
    });

    return {
      planId,
      expiresAt: new Date(expires).toISOString(),
      stateVersion: state.version,
      kind: meta.kind,
      verdict: a.check.verdict,
      tier: a.tier.tier,
      tierWhy: a.tier.why,
      affects: a.tier.affects,
      speech: a.speech,
      diff: a.diff,
      timeline: a.check.timeline,
      violations: a.check.reasons.flatMap((r) =>
        r.kind === 'violation' || r.kind === 'not_robust'
          ? [
              {
                rule: r.rule,
                text: r.text,
                author: r.author,
                priority: r.priority,
                ...(r.refuse ? { refuse: true } : {}),
                run: r.run,
                firstAt: r.firstAt,
                ...(r.cause ? { cause: r.cause } : {}),
              },
            ]
          : [],
      ),
      invalid: a.check.reasons.flatMap((r) =>
        r.kind === 'invalid'
          ? [{ code: r.code, actionIndex: r.actionIndex, message: r.message }]
          : [],
      ),
      unknowns: a.check.unknowns,
      horizon: a.check.horizon,
      repair:
        a.repaired && repairId
          ? {
              planId: repairId,
              verdict: a.repaired.check.verdict,
              tier: a.repaired.tier.tier,
              diff: a.repaired.diff,
              changes: a.repaired.detail.repairs.map((r) => ({
                rule: r.rule,
                kind: r.kind,
                description: r.description,
              })),
            }
          : null,
      safePart:
        a.safePart && safeId
          ? {
              planId: safeId,
              verdict: a.safePart.check.verdict,
              tier: a.safePart.tier.tier,
              diff: a.safePart.diff,
              dropped: a.safePart.detail.dropped,
            }
          : null,
    };
  }

  /** A new preview of a stored plan, at the current time. */
  private fresh(state: LiveState, nowMs: number, record: PreviewRecord): Promise<PreviewOutput> {
    return this.preview(
      state,
      nowMs,
      retime(record.plan, isoAt(nowMs, state.home.home.utcOffset)),
      {
        kind: record.kind === 'undo' ? 'undo' : 'plan',
        intent: record.intent,
        ...(record.requestedBy ? { requestedBy: record.requestedBy } : {}),
        ...(record.undo ? { undo: record.undo } : {}),
      },
    );
  }

  /** Bring the twin up to the current home time and log what fired. */
  private async current(): Promise<{ state: LiveState; nowMs: number }> {
    const state = await this.store.loadState();
    const nowMs = this.clock.homeNowMs();
    const fired = sync(state, nowMs);
    if (fired.length > 0) {
      const log = await this.store.listLog();
      for (const entry of fired) {
        // A write a commit queued has now run: record it on that commit so undo can put it back.
        const queuedBy =
          entry.source === 'scheduled' ? log.find((e) => e.id === entry.cause) : undefined;
        if (queuedBy?.undo) {
          for (const c of entry.changes) {
            if (c.target === 'home') continue;
            queuedBy.undo.writes.push({ device: c.target, attr: c.attr, from: c.from, to: c.to });
          }
          await this.store.putLog(queuedBy);
        }
        await this.store.putLog(entry);
      }
      await this.store.saveState(state);
    }
    return { state, nowMs };
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function retime(plan: Plan, now: string): Plan {
  return { ...plan, context: { ...plan.context, now } };
}

function refused(
  reason: NonNullable<CommitOutput['reason']>,
  planId: string,
  why: string,
): CommitOutput {
  return {
    status: 'refused',
    reason,
    planId,
    speech: { headline: clip(why, 15) },
    applied: [],
    held: [],
  };
}

function nothingToUndo(headline: string, undoOf?: string): UndoOutput {
  return {
    status: 'nothing_to_undo',
    ...(undoOf ? { undoOf } : {}),
    cannotUndo: [],
    notes: [],
    speech: { headline },
  };
}

function committedHeadline(applied: number, held: number): string {
  const now = applied === 1 ? 'one change' : `${applied} changes`;
  if (held === 0) return applied === 0 ? 'Done. Nothing needed changing.' : `Done: ${now}.`;
  return `Done: ${now} now, ${held} scheduled for later.`;
}

function clip(text: string, max: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(' ') : `${words.slice(0, max - 1).join(' ')} …`;
}

/** The new rule's own outcome on a sample day: did the home as it is break it? */
function ruleOutcome(result: CheckResult, id: string): AddRuleOutput['sampleDay'] {
  const reason = result.reasons.find((r) => 'rule' in r && r.rule === id);
  if (!reason) return { verdict: 'SAFE' };
  if (reason.kind === 'violation') return { verdict: 'UNSAFE', brokenAt: reason.firstAt };
  if (reason.kind === 'not_robust') return { verdict: 'UNPROVEN', brokenAt: reason.firstAt };
  return { verdict: 'UNPROVEN' };
}

/**
 * Existing rules that want the opposite of the new one for some device attribute: one rule
 * forbids a value the other requires. Priority decides which wins; on a tie the existing rule does.
 */
function findConflicts(home: Home, rule: Rule): AddRuleOutput['conflicts'] {
  const order = home.rulePriorityOrder;
  const wants = (a: RuleAtom): { key: string; value: Value; wanted: boolean } | null => {
    const c = a.cond;
    if (!c) return null;
    const isEq = 'eq' in c;
    const value = 'eq' in c ? c.eq : c.neq;
    // Making an `eq` atom true moves toward breaking the rule when towardViolation is set.
    const wanted = isEq ? !a.towardViolation : a.towardViolation;
    return { key: `${a.device}\u0000${c.attr}`, value, wanted };
  };
  const mine = ruleAtoms(home, rule)
    .map(wants)
    .filter((x) => x !== null);
  const out: AddRuleOutput['conflicts'] = [];
  for (const other of home.rules) {
    const theirs = ruleAtoms(home, other)
      .map(wants)
      .filter((x) => x !== null);
    const clash = mine.some((m) =>
      theirs.some((t) => t.key === m.key && t.value === m.value && t.wanted !== m.wanted),
    );
    if (!clash) continue;
    const winner =
      order.indexOf(rule.priority) < order.indexOf(other.priority) ? rule.id : other.id;
    out.push({ rule: other.id, text: other.text, priority: other.priority, winner });
  }
  return out;
}
