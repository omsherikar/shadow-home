import { AsyncLocalStorage } from 'node:async_hooks';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { Approval, LiveState, LogEntry, PreviewRecord, Store } from './store.ts';
import { asStored, copy, fromStored } from './stored.ts';

export interface DynamoStoreOptions {
  client: DynamoDBDocumentClient;
  /** A table with string keys `pk` and `sk`. */
  table: string;
  /**
   * Which home the next call uses. Each key's items are kept apart, so a new key starts from
   * `initial` with an empty log. The deployed server moves to a new key every day.
   */
  homeKey: () => string;
  /** The state a home starts from. */
  initial: () => LiveState;
  /** When an item may be deleted, in epoch seconds (the table's TTL attribute `expiresAt`). */
  expiresAt?: () => number;
  /** How many times a call runs before giving up when other calls keep changing the home. */
  maxAttempts?: number;
}

/** One call's reads and buffered writes. */
interface Unit {
  pk: string;
  /** The state item's revision when this call first read it; null: there was none yet. */
  rev?: number | null;
  state?: LiveState;
  newState?: LiveState;
  log?: LogEntry[];
  /** Buffered writes by sort key, in the order they were made. */
  writes: Map<string, unknown>;
}

const STATE = 'state';
const MAX_ITEMS = 100;

/**
 * The deployed server's store: one DynamoDB table. Each call reads what it needs and buffers its
 * writes; at the end they land in one transaction, on condition that the home's state item still
 * has the revision the call read. If another instance changed the home in between, the call runs
 * again on the newer home. Every item is stored as JSON, exactly as the in-memory store copies it.
 */
export function dynamoStore(options: DynamoStoreOptions): Store {
  const { client, table } = options;
  const units = new AsyncLocalStorage<Unit>();
  const maxAttempts = options.maxAttempts ?? 8;

  const get = async (pk: string, sk: string) =>
    (await client.send(new GetCommand({ TableName: table, Key: { pk, sk }, ConsistentRead: true })))
      .Item;

  const inUnit = (what: string): Unit => {
    const unit = units.getStore();
    if (!unit) throw new Error(`${what} must run inside atomically()`);
    return unit;
  };

  async function readState(unit: Unit): Promise<LiveState> {
    if (unit.newState) return copy(unit.newState);
    if (!unit.state) {
      const item = await get(unit.pk, STATE);
      unit.rev = item ? Number(item.rev) : null;
      unit.state = item ? fromStored<LiveState>(String(item.data)) : options.initial();
    }
    return copy(unit.state);
  }

  async function readItem<T>(prefix: string, id: string): Promise<T | undefined> {
    const unit = units.getStore();
    const sk = `${prefix}#${id}`;
    if (unit?.writes.has(sk)) return fromStored<T>(asStored(unit.writes.get(sk)));
    const item = await get(unit?.pk ?? options.homeKey(), sk);
    return item ? fromStored<T>(String(item.data)) : undefined;
  }

  async function queryLog(pk: string): Promise<LogEntry[]> {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :log)',
          ExpressionAttributeValues: { ':pk': pk, ':log': 'log#' },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      items.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start);
    return items
      .sort((a, b) => Number(a.ord) - Number(b.ord))
      .map((i) => fromStored<LogEntry>(String(i.data)));
  }

  /** Write what the call buffered. False when another call changed the home first. */
  async function commit(unit: Unit): Promise<boolean> {
    const logs = [...unit.writes.keys()].filter((k) => k.startsWith('log#'));
    if (!unit.newState && unit.writes.size === 0) return true;
    if (unit.rev === undefined) await readState(unit);
    const rev = unit.rev ?? null;
    const changesHome = unit.newState !== undefined || logs.length > 0;
    const next = (rev ?? 0) + 1;
    const ttl = options.expiresAt?.();
    const expiry = ttl === undefined ? {} : { expiresAt: ttl };
    const unchanged =
      rev === null
        ? { ConditionExpression: 'attribute_not_exists(sk)' }
        : {
            ConditionExpression: 'rev = :rev',
            ExpressionAttributeValues: { ':rev': rev },
          };
    const key = (sk: string) => ({ pk: unit.pk, sk });
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [];

    if (changesHome) {
      const state = unit.newState ?? unit.state ?? options.initial();
      items.push({
        Put: {
          TableName: table,
          Item: { ...key(STATE), data: asStored(state), rev: next, ...expiry },
          ...unchanged,
        },
      });
    } else {
      items.push({ ConditionCheck: { TableName: table, Key: key(STATE), ...unchanged } });
    }
    let order = 0;
    for (const [sk, value] of unit.writes) {
      if (sk.startsWith('log#')) {
        // A log entry keeps its place when it's rewritten (an undo marks what it undid).
        items.push({
          Update: {
            TableName: table,
            Key: key(sk),
            UpdateExpression: `SET #data = :data, ord = if_not_exists(ord, :ord)${ttl === undefined ? '' : ', expiresAt = :ttl'}`,
            ExpressionAttributeNames: { '#data': 'data' },
            ExpressionAttributeValues: {
              ':data': asStored(value),
              ':ord': next * 1000 + order++,
              ...(ttl === undefined ? {} : { ':ttl': ttl }),
            },
          },
        });
      } else {
        items.push({
          Put: { TableName: table, Item: { ...key(sk), data: asStored(value), ...expiry } },
        });
      }
    }
    if (items.length > MAX_ITEMS) {
      throw new Error(`One call wrote ${items.length} items; a transaction holds ${MAX_ITEMS}.`);
    }
    try {
      await client.send(new TransactWriteCommand({ TransactItems: items }));
      return true;
    } catch (e) {
      if (e instanceof TransactionCanceledException && retryable(e)) return false;
      throw e;
    }
  }

  return {
    async loadState() {
      const unit = units.getStore();
      if (unit) return readState(unit);
      const item = await get(options.homeKey(), STATE);
      return item ? fromStored<LiveState>(String(item.data)) : options.initial();
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
      if (!unit.log) unit.log = await queryLog(unit.pk);
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
        const unit: Unit = { pk: options.homeKey(), writes: new Map() };
        // Read the home first, so every later read in the call is covered by the revision the
        // transaction checks (a commit's look for its stored result included).
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

/** Lost a race: the home changed since this call read it, or another transaction held an item. */
function retryable(e: TransactionCanceledException): boolean {
  const codes = (e.CancellationReasons ?? []).map((r) => r.Code);
  return (
    codes.length > 0 &&
    codes.every(
      (c) => c === 'None' || c === 'ConditionalCheckFailed' || c === 'TransactionConflict',
    )
  );
}
