import {
  assess,
  type CheckResult,
  check,
  diffPlan,
  planSummary,
  type RuleAtom,
  reversibility,
  ruleAtoms,
  type Speech,
  speech,
  type TierResult,
  untrustedSensors,
} from '@shadow-home/engine';
import type { CompileOutcome } from '@shadow-home/rules';
import {
  type Home,
  type HomeMode,
  type Plan,
  type PlanAction,
  planContextSchema,
  type Rule,
  ruleSchema,
  type Value,
  validateHome,
} from '@shadow-home/twin';
import type { Names } from '@shadow-home/views';
import type { z } from 'zod';
import type { Clock } from './clock.ts';
import { applyPlan, snapshot, sync } from './live-home.ts';
import {
  approvalToken,
  newNonce,
  signPlanId,
  verifyApprovalToken,
  verifyPlanId,
} from './plan-id.ts';
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
  UndoInfo,
} from './store.ts';
import { isoAt } from './time.ts';

export interface ServiceOptions {
  store: Store;
  clock: Clock;
  /** HMAC key for plan IDs. */
  secret: string;
  /** How long a plan ID stays valid. Default 5 minutes. */
  previewTtlMs?: number;
  /**
   * Turns a house rule in plain words into a template: several compilers that must agree. Without
   * it, add_house_rule needs the compiled rule from the caller.
   */
  compileRule?: (input: { text: string; author: string; home: Home }) => Promise<CompileOutcome>;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Most log entries one catch-up step writes, well inside a DynamoDB transaction's 100 items. */
const CATCH_UP_LIMIT = 40;

/**
 * The seven tools' logic, independent of MCP. Calls run one at a time: each first brings the
 * twin up to the current home time, then reads or changes it.
 */
export class ShadowHomeService {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly compileRule: ServiceOptions['compileRule'];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ServiceOptions) {
    this.store = options.store;
    this.clock = options.clock;
    this.secret = options.secret;
    this.ttlMs = options.previewTtlMs ?? 5 * 60_000;
    this.compileRule = options.compileRule;
  }

  /** Display names for the plan view: each device with its room, routines and household members. */
  async names(): Promise<Names> {
    const { home } = await this.store.loadState();
    const rooms = new Map(home.rooms.map((r) => [r.id, r.name]));
    return {
      devices: Object.fromEntries(
        home.devices.map((d) => [d.id, { name: d.name, room: rooms.get(d.room) ?? d.room }]),
      ),
      routines: Object.fromEntries(home.routines.map((r) => [r.id, r.name])),
      members: Object.fromEntries(home.household.members.map((m) => [m.id, m.name])),
    };
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
      // Every time in the context must carry an offset: without one, Date.parse would read it in
      // the server's own time zone and the verdict would depend on where the server runs.
      planContextSchema.parse(plan.context);
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
          ...(await this.freshPreview(state, nowMs, record)),
        };
      }
      let version = verified.claims.v;
      // A yes answers the question this preview asked. On the safe-part path it counts only if
      // that question offered the safe part; otherwise the safe part asks its own.
      let confirmed = input.confirmed === true;
      if (input.safePartOnly) {
        const safeId = record.related.safePart;
        if (!safeId)
          return refused('no_safe_part', planId, 'No part of that plan is safe on its own.');
        confirmed = confirmed && record.offers === 'safe_part';
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
        ...(await this.freshPreview(state, nowMs, record as PreviewRecord)),
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
      // A repair or safe part isn't what the person asked for, so it needs their yes whatever
      // its tier, like any T2 or T4 plan.
      const alternative = record.kind === 'repair' || record.kind === 'safe_part';
      if (record.tier === 'T2' || record.tier === 'T4' || alternative) {
        const approved = await this.store.getApproval(record.nonce);
        // A yes counts only if the question asked was about this plan: its own question, or for
        // an alternative, the parent's question that offered it. A plan whose own question offered
        // an alternative ("Do just the part I can confirm?") asks its own ("Run it anyway?") first.
        const askedAboutThis =
          record.askedOwn === true ||
          (alternative ? record.offeredByParent === true : record.offers === null);
        if ((!confirmed || !askedAboutThis) && !approved) {
          if (!askedAboutThis) await this.store.putPreview({ ...record, askedOwn: true });
          const ask =
            (record.offers !== null ? record.ownAsk : record.speech.ask) ?? 'Shall I go ahead?';
          return {
            status: 'needs_confirmation',
            planId,
            speech: { headline: 'I need a yes first.', ask },
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
        if (original?.undo) {
          const rest = withoutUndone(original.undo, plan, record.undo);
          await this.store.putLog({
            ...original,
            undo: rest,
            ...(nothingLeft(rest) ? { undoneBy: logId } : {}),
          });
        }
      }
      await this.store.putLog(entry);
      await this.store.saveState(state);
      const result: CommitOutput = {
        status: 'committed',
        planId,
        speech: { headline: committedHeadline(record.summary, applied.length, held.length) },
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
      const log = await this.store.listLog();
      const entry =
        input.token === 'last'
          ? log
              .filter((e) => e.undo && !e.undoneBy && (e.source === 'plan' || e.source === 'undo'))
              .at(-1)
          : log.find((e) => e.undoToken === input.token);
      if (!entry?.undo) return nothingToUndo("There's nothing to undo.");
      if (entry.undoneBy) return nothingToUndo('That was already undone.', entry.id);
      return this.undoFor(state, nowMs, entry, input.devices);
    });
  }

  /**
   * Work out how to put back what a log entry changed, as it stands now, and preview it. Each
   * attribute goes back to its value before the entry's first write, if nothing has changed it
   * since; scheduled writes and mode changes that haven't happened are cancelled; routine pauses
   * go back to what they were.
   */
  private async undoFor(
    state: LiveState,
    nowMs: number,
    entry: LogEntry,
    devices?: string[],
  ): Promise<UndoOutput> {
    const home = state.home;
    const info = entry.undo;
    if (!info) return nothingToUndo("There's nothing to undo.");
    const only = devices ? new Set(devices) : null;
    const pick = (id: string) => !only || only.has(id);
    const actions: PlanAction[] = [];
    const cannotUndo: UndoOutput['cannotUndo'] = [];
    const notes: string[] = [];

    for (const w of netWrites(info.writes)) {
      if (!pick(w.device)) continue;
      const now = home.devices.find((d) => d.id === w.device)?.state[w.attr];
      if (info.irreversible.some((x) => x.device === w.device && x.attr === w.attr)) {
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
    if (info.mode && pick('home')) {
      if (home.mode === info.mode.after) actions.push({ mode: info.mode.before });
      else
        cannotUndo.push({
          target: 'home',
          attr: 'mode',
          why: `it has changed since, to ${home.mode}`,
        });
    }
    const queued = home.scheduled ?? [];
    const cancel = info.scheduled.filter(
      (w) => pick(w.device) && queued.some((q) => JSON.stringify(q) === JSON.stringify(w)),
    );
    const cancelModes = pick('home')
      ? info.pendingModes.filter((m) =>
          state.pendingModes.some(
            (p) => p.atMs === m.atMs && p.source === m.source && p.mode === m.mode,
          ),
        )
      : [];
    const pauses = netPauses(info.pauses)
      .filter((p) => pick(p.routine))
      .filter((p) => home.routines.find((r) => r.id === p.routine)?.pausedUntil === p.after)
      .map((p) => ({ routine: p.routine, pausedUntil: p.before }));
    if (
      actions.length === 0 &&
      cancel.length === 0 &&
      cancelModes.length === 0 &&
      pauses.length === 0
    ) {
      return { ...nothingToUndo('Nothing from that can be put back.', entry.id), cannotUndo };
    }
    const offset = home.home.utcOffset;
    for (const c of cancel) notes.push(`Cancels ${c.device} at ${c.at}; it hasn't run yet.`);
    for (const m of cancelModes)
      notes.push(`Cancels the change to ${m.mode} mode at ${isoAt(m.atMs, offset)}.`);
    for (const p of pauses) {
      const name = home.routines.find((r) => r.id === p.routine)?.name ?? p.routine;
      notes.push(p.pausedUntil ? `${name} goes back to its earlier pause.` : `${name} resumes.`);
    }
    if (actions.length > 0) {
      notes.push('Settings go back; what already happened while they were changed stays.');
    }
    const extras: UndoExtras = {
      of: entry.id,
      ...(devices ? { devices } : {}),
      cancel,
      cancelModes,
      pauses,
    };
    const plan: Plan = { context: { now: isoAt(nowMs, offset) }, actions };
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

  async addHouseRule(input: z.infer<typeof addRuleInput>): Promise<AddRuleOutput> {
    // With a compiler, the person's words decide: a compiled rule from the caller would skip the
    // agreement check. Without one (the recorded demo), the caller's compiled rule is used.
    let compiled = this.compileRule ? undefined : input.rule;
    let hash: string | undefined;
    if (!compiled) {
      const notCompiled = (problems: string[], headline: string): AddRuleOutput => ({
        status: 'needs_compiler',
        problems,
        conflicts: [],
        needsOwnerApproval: false,
        speech: { headline },
      });
      if (!this.compileRule) {
        return notCompiled(
          ['The rule compiler is not connected; send the compiled rule in `rule`.'],
          "I can't turn that into a rule yet.",
        );
      }
      // Compiling asks several models and takes seconds, so it happens before this call takes
      // its turn with the home; the rule is then checked against the home as it is.
      const { home } = await this.store.loadState();
      const outcome = await this.compileRule({ text: input.text, author: input.author, home });
      if (outcome.status === 'failed') {
        return notCompiled(outcome.problems, "I couldn't work out that rule just now.");
      }
      if (outcome.status === 'unsupported') {
        // The compiler's reason goes on screen; what's spoken is the server's own words.
        return {
          status: 'invalid',
          problems: [outcome.reason],
          conflicts: [],
          needsOwnerApproval: false,
          speech: {
            headline: "I can't make that a house rule.",
            reason: "It doesn't fit the kinds of rule I can check.",
          },
        };
      }
      if (outcome.status === 'disagree') {
        const say = (r: (typeof outcome.readings)[number]) =>
          readBack(home, { ...r, id: 'new', text: input.text, author: input.author } as Rule);
        const sentences = outcome.readings.map(say);
        // The read-back doesn't say how strict a rule is, so readings that differ only there
        // read alike: name the priority, and whether it may never happen at all.
        const alike = new Set(sentences).size < sentences.length;
        const readings = alike
          ? outcome.readings.map(
              (r) => `${say(r)} (${r.priority}${r.refuse ? ', never allowed' : ''})`,
            )
          : sentences;
        const onlyStrictness = alike && new Set(sentences).size === 1;
        return {
          status: 'unclear',
          readings,
          problems: outcome.unsupported,
          conflicts: [],
          needsOwnerApproval: false,
          speech: onlyStrictness
            ? {
                headline: "I'm not sure how strict that rule is.",
                reason: 'I can read it as more than one kind of rule.',
                ask: "Can you say it again, and say whether it's about safety, security, a device, or comfort?",
              }
            : {
                headline: "I'm not sure what that rule means.",
                reason:
                  readings.length > 1
                    ? `I can read it ${readings.length} ways.`
                    : "I'm not sure it's a rule I can check.",
                ask: 'Can you say it again, naming the device and when it applies?',
              },
        };
      }
      compiled = outcome.rule;
      hash = outcome.hash;
    }
    const wanted = compiled;
    return this.exclusive(async () => {
      const { state, nowMs } = await this.current();
      const home = state.home;
      const id = `R${Math.max(0, ...home.rules.map((r) => Number(r.id.slice(1)) || 0)) + 1}`;
      const parsed = ruleSchema.safeParse({
        ...wanted,
        id,
        text: input.text,
        author: input.author,
        source: 'add_house_rule',
        ...(hash ? { hash } : {}),
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

  /** Start the home over (the local demo's reset). Waits for any call in progress. */
  reset(state: LiveState): Promise<void> {
    return this.exclusive(() => this.store.reset(state));
  }

  /** The token that lets the screen showing this plan approve it (see plan-id.ts). */
  approvalToken(planId: string): string {
    return approvalToken(this.secret, planId);
  }

  /**
   * A tap on screen, standing in for a spoken yes. Only the plan view has the plan's approval
   * token, so a model that can see this tool (a host that ignores `visibility`) can't use it.
   */
  approvePlan(input: { planId: string; approvalToken: string }): Promise<ApproveOutput> {
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
      if (!verifyApprovalToken(this.secret, input.planId, input.approvalToken)) {
        return { status: 'refused', reason: 'not_from_screen', planId: input.planId };
      }
      const record = await this.store.getPreview(v.claims.n);
      if (!record) return { status: 'refused', reason: 'unknown_plan', planId: input.planId };
      // Nothing can approve what never commits.
      if (record.tier === 'T3' || record.tier === 'T5') {
        return { status: 'refused', reason: 'unsafe', planId: input.planId };
      }
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
      offers: PreviewRecord['offers'] = null,
      ownAsk?: string,
      offeredByParent?: boolean,
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
        summary: planSummary(diffPlan(home, p)),
        irreversible: reversibility(home, p).some((x) => x.irreversibleOnceFired),
        related,
        offers,
        ...(ownAsk ? { ownAsk } : {}),
        ...(offeredByParent !== undefined ? { offeredByParent } : {}),
        ...(meta.undo ? { undo: meta.undo } : {}),
      });
      return signPlanId(this.secret, { n: nonce, v: state.version, x: expires });
    };
    const repairId = a.repaired
      ? await save(
          'repair',
          a.repaired.plan,
          a.repaired.check,
          a.repaired.tier,
          a.repaired.speech,
          {},
          null,
          undefined,
          a.offered === 'repair',
        )
      : undefined;
    const safeId = a.safePart
      ? await save(
          'safe_part',
          a.safePart.plan,
          a.safePart.check,
          a.safePart.tier,
          a.safePart.speech,
          {},
          null,
          undefined,
          a.offered === 'safe_part',
        )
      : undefined;
    const planId = await save(
      meta.kind,
      plan,
      a.check,
      a.tier,
      a.speech,
      {
        ...(repairId ? { repair: repairId } : {}),
        ...(safeId ? { safePart: safeId } : {}),
      },
      a.offered,
      // The question this plan asks when nothing else is offered: "Run it anyway?".
      a.offered ? speech(home, plan, a.check, a.tier, a.diff).ask : undefined,
    );

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
                ...(r.actionIndex !== undefined ? { actionIndex: r.actionIndex } : {}),
                target: r.target,
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

  /**
   * A new preview to replace a stale or expired one. A plan is checked again as it was asked; an
   * undo is worked out again from the log, since what can be put back may have changed.
   */
  private async freshPreview(
    state: LiveState,
    nowMs: number,
    record: PreviewRecord,
  ): Promise<{ freshPreview?: PreviewOutput }> {
    if (record.kind === 'undo' && record.undo) {
      const entry = (await this.store.listLog()).find((e) => e.id === record.undo?.of);
      if (!entry || entry.undoneBy) return {};
      const again = await this.undoFor(state, nowMs, entry, record.undo.devices);
      return again.preview ? { freshPreview: again.preview } : {};
    }
    const plan = retime(record.plan, isoAt(nowMs, state.home.home.utcOffset));
    return {
      freshPreview: await this.preview(state, nowMs, plan, {
        kind: 'plan',
        intent: record.intent,
        ...(record.requestedBy ? { requestedBy: record.requestedBy } : {}),
      }),
    };
  }

  /**
   * Bring the twin up to the current home time and log what fired. The returned `nowMs` is
   * whole seconds and always after the last synced minute, so the engine never runs that minute's
   * routine steps or scheduled writes a second time.
   */
  private async current(): Promise<{ state: LiveState; nowMs: number }> {
    const state = await this.store.loadState();
    const raw = this.clock.homeNowMs();
    await this.record(state, syncUntil(state, raw));
    const nowMs = Math.max(Math.ceil(raw / 1000) * 1000, state.syncedToMs + 1000);
    return { state, nowMs };
  }

  /**
   * After a quiet spell, more may have fired than one call can log (a DynamoDB transaction holds
   * 100 items). Then bring the twin forward to just before the entry that doesn't fit, saved on
   * its own; true while there's more to catch up. Usually there isn't, and this saves nothing.
   */
  private async catchUpStep(): Promise<boolean> {
    const state = await this.store.loadState();
    const fired = syncUntil(structuredClone(state), this.clock.homeNowMs()).sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at),
    );
    const cut = fired[CATCH_UP_LIMIT];
    if (!cut) return false;
    const untilMs = Date.parse(cut.at) - MINUTE_MS;
    // One minute holding more than fits can't be split; the call goes ahead and may fail.
    if (untilMs <= state.syncedToMs) return false;
    const step = syncUntil(state, untilMs);
    if (step.length === 0) return false;
    await this.record(state, step);
    return true;
  }

  /** Log what fired, note it on the commits that queued it, and save the twin. */
  private async record(state: LiveState, fired: LogEntry[]): Promise<void> {
    if (fired.length === 0) return;
    const log = await this.store.listLog();
    const devices = new Map(state.home.devices.map((d) => [d.id, d]));
    for (const entry of fired) {
      // Something a commit queued has now happened: record it on that commit so undo knows.
      const queuedBy =
        entry.source === 'scheduled' ? log.find((e) => e.id === entry.cause) : undefined;
      if (queuedBy?.undo) {
        const info = queuedBy.undo;
        for (const c of entry.changes) {
          if (c.target === 'home') {
            info.mode = { before: c.from as HomeMode, after: c.to as HomeMode };
            info.pendingModes = info.pendingModes.filter(
              (m) => isoAt(m.atMs, state.home.home.utcOffset) !== entry.at,
            );
            continue;
          }
          info.writes.push({ device: c.target, attr: c.attr, from: c.from, to: c.to });
          if (devices.get(c.target)?.irreversible?.includes(c.attr)) {
            info.irreversible.push({ device: c.target, attr: c.attr });
          }
        }
        info.scheduled = info.scheduled.filter((w) =>
          (state.home.scheduled ?? []).some((q) => JSON.stringify(q) === JSON.stringify(w)),
        );
        await this.store.putLog(queuedBy);
      }
      await this.store.putLog(entry);
    }
    await this.store.saveState(state);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const unit = async () => {
      for (;;) {
        if (!(await this.store.atomically(() => this.catchUpStep()))) break;
      }
      return this.store.atomically(fn);
    };
    const run = this.queue.then(unit, unit);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** Simulate the twin forward to `untilMs`, in as many syncs as that takes. */
function syncUntil(state: LiveState, untilMs: number): LogEntry[] {
  const fired: LogEntry[] = [];
  let before = Number.NaN;
  while (state.syncedToMs !== before) {
    before = state.syncedToMs;
    fired.push(...sync(state, untilMs));
  }
  return fired;
}

/** Net effect per attribute: the value before the first write, the value after the last. */
function netWrites(writes: UndoInfo['writes']): UndoInfo['writes'] {
  const net = new Map<string, UndoInfo['writes'][number]>();
  for (const w of writes) {
    const key = `${w.device}\u0000${w.attr}`;
    const seen = net.get(key);
    if (seen) seen.to = w.to;
    else net.set(key, { ...w });
  }
  return [...net.values()];
}

/** Net effect per routine: the pause before the first change, the pause after the last. */
function netPauses(pauses: UndoInfo['pauses']): UndoInfo['pauses'] {
  const net = new Map<string, UndoInfo['pauses'][number]>();
  for (const p of pauses) {
    const seen = net.get(p.routine);
    if (seen) seen.after = p.after;
    else net.set(p.routine, { ...p });
  }
  return [...net.values()];
}

/** What's left to undo of an entry after an undo put some of it back. */
function withoutUndone(info: UndoInfo, plan: Plan, extras: UndoExtras): UndoInfo {
  const reverted = new Set<string>();
  let modeReverted = false;
  for (const a of plan.actions) {
    if ('device' in a)
      for (const attr of Object.keys(a.set)) reverted.add(`${a.device}\u0000${attr}`);
    if ('mode' in a) modeReverted = true;
  }
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const rest: UndoInfo = {
    writes: info.writes.filter((w) => !reverted.has(`${w.device}\u0000${w.attr}`)),
    scheduled: info.scheduled.filter((w) => !extras.cancel.some((c) => same(c, w))),
    pendingModes: info.pendingModes.filter((m) => !extras.cancelModes.some((c) => same(c, m))),
    pauses: info.pauses.filter((p) => !extras.pauses.some((x) => x.routine === p.routine)),
    irreversible: info.irreversible,
  };
  if (info.mode && !modeReverted) rest.mode = info.mode;
  return rest;
}

/** Nothing left that an undo could put back. */
function nothingLeft(info: UndoInfo): boolean {
  const reversible = info.writes.filter(
    (w) => !info.irreversible.some((x) => x.device === w.device && x.attr === w.attr),
  );
  return (
    reversible.length === 0 &&
    info.scheduled.length === 0 &&
    info.pendingModes.length === 0 &&
    info.pauses.length === 0 &&
    !info.mode
  );
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

function committedHeadline(summary: string, applied: number, held: number): string {
  if (applied === 0 && held === 0) return 'Done. Nothing needed changing.';
  if (applied === 0) return clip(`Scheduled: ${summary}.`, 15);
  return clip(held > 0 ? `Done: ${summary}, some of it later.` : `Done: ${summary}.`, 15);
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
