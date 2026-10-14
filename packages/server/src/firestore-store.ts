import { AsyncLocalStorage } from 'node:async_hooks';
import { type Firestore, Timestamp } from '@google-cloud/firestore';
import type { Approval, LiveState, LogEntry, PreviewRecord, Store } from './store.ts';
import { asStored, copy, fromStored } from './stored.ts';

export interface FirestoreStoreOptions {
  db: Firestore;
  /** The collection each home is a document in (default "homes"). */
  collection?: string;
  /**
   * Which home the next call uses. Each key's documents are kept apart, so a new key starts from
   * `initial` with an empty log. The deployed server moves to a new key every day.
   */
  homeKey: () => string;
  /** The state a home starts from. */
  initial: () => LiveState;
  /** When a document may be deleted, in epoch milliseconds (a Timestamp `expiresAt`, for a TTL policy). */
  expiresAt?: () => number;
  /** How many times a call runs before giving up when other calls keep changing the home. */
  maxAttempts?: number;
}

/** One call's reads and buffered writes. */
interface Unit {
  key: string;
  /** The home document's update time when this call first read it; null: there was none yet. */
  readAt?: Timestamp | null;
  rev?: number;
  state?: LiveState;
  newState?: LiveState;
  log?: LogEntry[];
  /** Buffered writes by key ("preview#…", "log#…"), in the order they were made. */
  writes: Map<string, unknown>;
}

/** The most writes Firestore takes in one commit. */
const MAX_WRITES = 500;
// gRPC status codes for a commit that lost a race: the home changed, or appeared, since the read.
const ALREADY_EXISTS = 6;
const FAILED_PRECONDITION = 9;
const ABORTED = 10;

/**
 * The deployed server's store on Google Cloud: Firestore. A home is one document holding its
 * state, with its previews, approvals and commit results in `items` and its log in `log` under
 * it. Each call reads what it needs and buffers its writes; at the end they land in one batch, on
 * condition that the home document hasn't changed since the call read it. If another instance
 * changed the home in between, the call runs again on the newer home. Values are stored as JSON,
 * exactly as the in-memory store copies them.
 *
 * A batch with a precondition, not a transaction: a transaction in the server SDK locks what it
 * reads until it commits, so one slow call (three simulations, a rule compile) would hold up every
 * other. The precondition checks what the DynamoDB store's condition checks, with no locks held.
 */
export function firestoreStore(options: FirestoreStoreOptions): Store {
  const { db } = options;
  const homes = db.collection(options.collection ?? 'homes');
  const units = new AsyncLocalStorage<Unit>();
  const maxAttempts = options.maxAttempts ?? 8;

  // Plan IDs come from the caller; encoded, no ID can name another path.
  const homeDoc = (key: string) => homes.doc(encodeURIComponent(key));
  const itemDoc = (key: string, sk: string) =>
    homeDoc(key).collection('items').doc(encodeURIComponent(sk));
  const logDoc = (key: string, id: string) =>
    homeDoc(key).collection('log').doc(encodeURIComponent(id));

  const inUnit = (what: string): Unit => {
    const unit = units.getStore();
    if (!unit) throw new Error(`${what} must run inside atomically()`);
    return unit;
  };

  async function readState(unit: Unit): Promise<LiveState> {
    if (unit.newState) return copy(unit.newState);
    if (!unit.state) {
      const doc = await homeDoc(unit.key).get();
      unit.readAt = doc.exists ? (doc.updateTime ?? null) : null;
      unit.rev = doc.exists ? Number(doc.get('rev')) : 0;
      unit.state = doc.exists ? fromStored<LiveState>(String(doc.get('data'))) : options.initial();
    }
    return copy(unit.state);
  }

  async function readItem<T>(prefix: string, id: string): Promise<T | undefined> {
    const unit = units.getStore();
    const sk = `${prefix}#${id}`;
    if (unit?.writes.has(sk)) return fromStored<T>(asStored(unit.writes.get(sk)));
    const doc = await itemDoc(unit?.key ?? options.homeKey(), sk).get();
    return doc.exists ? fromStored<T>(String(doc.get('data'))) : undefined;
  }

  async function queryLog(key: string): Promise<LogEntry[]> {
    const page = await homeDoc(key).collection('log').orderBy('ord').get();
    return page.docs.map((d) => fromStored<LogEntry>(String(d.get('data'))));
  }

  /** Write what the call buffered. False when another call changed the home first. */
  async function commit(unit: Unit): Promise<boolean> {
    if (!unit.newState && unit.writes.size === 0) return true;
    if (unit.readAt === undefined) await readState(unit);
    const logs = [...unit.writes.keys()].filter((k) => k.startsWith('log#'));
    const changesHome = unit.newState !== undefined || logs.length > 0;
    const rev = unit.rev ?? 0;
    const next = rev + 1;
    const ttl = options.expiresAt?.();
    const expiry = ttl === undefined ? {} : { expiresAt: Timestamp.fromMillis(ttl) };
    if (unit.writes.size + 1 > MAX_WRITES) {
      throw new Error(
        `One call wrote ${unit.writes.size + 1} documents; a commit holds ${MAX_WRITES}.`,
      );
    }

    const home = homeDoc(unit.key);
    const state = unit.newState ?? unit.state ?? options.initial();
    const batch = db.batch();
    if (unit.readAt === null || unit.readAt === undefined) {
      // A new home: fails if another call created it first.
      batch.create(home, { data: asStored(state), rev: changesHome ? next : rev, ...expiry });
    } else if (changesHome) {
      batch.update(
        home,
        { data: asStored(state), rev: next, ...expiry },
        { lastUpdateTime: unit.readAt },
      );
    } else {
      // Writing the revision back unchanged leaves the home as it was, and still fails if another
      // call changed it (a commit's stored result must not land beside a different commit).
      batch.update(home, { rev }, { lastUpdateTime: unit.readAt });
    }

    // A log entry keeps its place when it's rewritten (an undo marks what it undid). Which ones
    // exist can be read here: a log write changes the home, so if another call adds an entry
    // after this read, the precondition fails and the call runs again.
    const refs = logs.map((sk) => logDoc(unit.key, sk.slice('log#'.length)));
    const existing = new Set(
      (refs.length > 0 ? await db.getAll(...refs) : []).filter((d) => d.exists).map((d) => d.id),
    );
    let order = 0;
    for (const [sk, value] of unit.writes) {
      if (sk.startsWith('log#')) {
        const ref = logDoc(unit.key, sk.slice('log#'.length));
        const fields = { data: asStored(value), ...expiry };
        if (existing.has(ref.id)) batch.set(ref, fields, { merge: true });
        else batch.set(ref, { ...fields, ord: next * 1000 + order });
        order++;
      } else {
        batch.set(itemDoc(unit.key, sk), { data: asStored(value), ...expiry });
      }
    }
    try {
      await batch.commit();
      return true;
    } catch (e) {
      if (lostRace(e)) return false;
      throw e;
    }
  }

  return {
    async loadState() {
      const unit = units.getStore();
      if (unit) return readState(unit);
      const doc = await homeDoc(options.homeKey()).get();
      return doc.exists ? fromStored<LiveState>(String(doc.get('data'))) : options.initial();
    },
    async saveState(state) {
      inUnit('saveState').newState = copy(state);
    },
    async putPreview(record) {
      inUnit('putPreview').writes.set(`preview#${record.nonce}`, copy(record));
    },
    getPreview: (nonce) => readItem<PreviewRecord>('preview', nonce),
    async putApproval(nonce, approval) {
      inUnit('putApproval').writes.set(`approval#${nonce}`, copy(approval));
    },
    getApproval: (nonce) => readItem<Approval>('approval', nonce),
    async putCommit(planId, result) {
      inUnit('putCommit').writes.set(`commit#${planId}`, copy(result));
    },
    getCommit: (planId) => readItem<unknown>('commit', planId),
    async putLog(entry) {
      inUnit('putLog').writes.set(`log#${entry.id}`, copy(entry));
    },
    async listLog() {
      const unit = units.getStore();
      if (!unit) return queryLog(options.homeKey());
      if (!unit.log) unit.log = await queryLog(unit.key);
      const entries = new Map(unit.log.map((e) => [e.id, e]));
      for (const [sk, value] of unit.writes) {
        if (sk.startsWith('log#')) {
          const entry = value as LogEntry;
          entries.set(entry.id, entry);
        }
      }
      return fromStored<LogEntry[]>(asStored([...entries.values()]));
    },
    async reset() {
      throw new Error('The deployed store has no reset: each home starts over on its own key.');
    },
    async atomically(fn) {
      for (let attempt = 1; ; attempt++) {
        const unit: Unit = { key: options.homeKey(), writes: new Map() };
        // Read the home first, so every later read in the call is covered by the update time the
        // commit checks (a commit's look for its stored result included).
        const result = await units.run(unit, async () => {
          await readState(unit);
          return fn();
        });
        if (await commit(unit)) return result;
        if (attempt >= maxAttempts) {
          throw new Error(`The home kept changing; gave up after ${attempt} attempts.`);
        }
        await new Promise((r) => setTimeout(r, Math.random() * 20 * attempt));
      }
    },
  };
}

/** Lost a race: the home changed or appeared since this call read it, or the commit contended. */
function lostRace(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  return code === FAILED_PRECONDITION || code === ALREADY_EXISTS || code === ABORTED;
}
