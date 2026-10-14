import type { Speech, Tier, Verdict } from '@shadow-home/engine';
import type { Home, HomeMode, Plan, Value } from '@shadow-home/twin';

/** The home as it is now, plus what's needed to move it forward in time. */
export interface LiveState {
  /** Device states, routine pauses, scheduled writes, mode and rules, as of `syncedToMs`. */
  home: Home;
  /**
   * Bumps on every discrete change: a commit, a routine or scheduled write firing, a mode
   * change, a new rule. Temperatures drifting don't count, or every preview would go stale
   * within a minute.
   */
  version: number;
  /** The last home-time minute simulated. */
  syncedToMs: number;
  /** Mode changes a plan scheduled for later. */
  pendingModes: PendingMode[];
}

export interface PendingMode {
  atMs: number;
  mode: HomeMode;
  /** The log entry of the commit that scheduled it. */
  source: string;
}

export type PreviewKind = 'plan' | 'repair' | 'safe_part' | 'undo';

/** Extra steps an undo takes besides writing old values back. */
export interface UndoExtras {
  /** The log entry being undone. */
  of: string;
  /** Only these devices (and "home" for the mode, routine IDs for pauses), if the undo named some. */
  devices?: string[];
  /** Scheduled writes to cancel before they fire. */
  cancel: ScheduledWrite[];
  /** Scheduled mode changes to cancel before they happen. */
  cancelModes: PendingMode[];
  /** Routine pauses to put back as they were (null: not paused). */
  pauses: { routine: string; pausedUntil: string | null }[];
}

export type ScheduledWrite = NonNullable<Home['scheduled']>[number];

export interface PreviewRecord {
  nonce: string;
  kind: PreviewKind;
  plan: Plan;
  intent: string;
  requestedBy?: string;
  stateVersion: number;
  verdict: Verdict;
  tier: Tier;
  /** What the preview said, so a refusal or a request for a yes can repeat it. */
  speech: Speech;
  /** What the plan does in a few words, for the commit's "Done: …". */
  summary: string;
  /** Some action can't be taken back once it fires. */
  irreversible: boolean;
  /** Plan IDs of the alternatives offered with this preview. */
  related: { repair?: string; safePart?: string };
  /** The alternative this preview's question offered; a yes to it counts for that alternative. */
  offers: 'repair' | 'safe_part' | null;
  /**
   * When the preview's question offered an alternative: the question about this plan itself
   * ("Run it anyway?"), and whether it has been asked. Only a yes to it commits this plan.
   */
  ownAsk?: string;
  askedOwn?: boolean;
  undo?: UndoExtras;
}

export interface WriteRecord {
  device: string;
  attr: string;
  from: Value | null;
  to: Value;
}

/** What a commit changed, so it can be put back. */
export interface UndoInfo {
  writes: WriteRecord[];
  scheduled: ScheduledWrite[];
  pendingModes: PendingMode[];
  pauses: { routine: string; before: string | null; after: string }[];
  mode?: { before: HomeMode; after: HomeMode };
  /** Writes that can't be put back. */
  irreversible: { device: string; attr: string }[];
}

export interface LogChange {
  /** Device ID, routine ID or "home". */
  target: string;
  attr: string;
  from: Value | null;
  to: Value;
}

export interface LogEntry {
  id: string;
  /** Home time. */
  at: string;
  /** Member ID: who asked, or the routine's owner. */
  who: string;
  source: 'plan' | 'undo' | 'routine' | 'scheduled';
  /** What the person asked, or the routine's name. */
  what: string;
  /** The routine ID, or the log entry of the plan that queued a scheduled write. */
  cause?: string;
  planId?: string;
  verdict?: Verdict;
  tier?: Tier;
  changes: LogChange[];
  undoToken?: string;
  undo?: UndoInfo;
  undoneBy?: string;
}

export interface Approval {
  at: number;
  by: 'screen';
}

/**
 * Where the server keeps state. The in-memory store runs locally and in tests; a DynamoDB
 * store implements the same interface for the deployed server.
 */
export interface Store {
  loadState(): Promise<LiveState>;
  saveState(state: LiveState): Promise<void>;
  putPreview(record: PreviewRecord): Promise<void>;
  getPreview(nonce: string): Promise<PreviewRecord | undefined>;
  putApproval(nonce: string, approval: Approval): Promise<void>;
  getApproval(nonce: string): Promise<Approval | undefined>;
  /** Commit results by plan ID, so a retried commit returns the same answer. */
  putCommit(planId: string, result: unknown): Promise<void>;
  getCommit(planId: string): Promise<unknown>;
  /** Adds an entry, or replaces one with the same ID in place. */
  putLog(entry: LogEntry): Promise<void>;
  /** Entries in the order they were first written. */
  listLog(): Promise<LogEntry[]>;
  /** A fresh home: this state, and no previews, approvals, commits or log. For the local demo. */
  reset(state: LiveState): Promise<void>;
}

export function memoryStore(initial: LiveState): Store {
  let state = initial;
  const previews = new Map<string, PreviewRecord>();
  const approvals = new Map<string, Approval>();
  const commits = new Map<string, unknown>();
  const log = new Map<string, LogEntry>();
  return {
    loadState: async () => state,
    saveState: async (s) => {
      state = s;
    },
    putPreview: async (r) => {
      previews.set(r.nonce, r);
    },
    getPreview: async (n) => previews.get(n),
    putApproval: async (n, a) => {
      approvals.set(n, a);
    },
    getApproval: async (n) => approvals.get(n),
    putCommit: async (id, r) => {
      commits.set(id, r);
    },
    getCommit: async (id) => commits.get(id),
    putLog: async (e) => {
      log.set(e.id, e);
    },
    listLog: async () => [...log.values()],
    reset: async (s) => {
      state = s;
      for (const m of [previews, approvals, commits, log]) m.clear();
    },
  };
}
