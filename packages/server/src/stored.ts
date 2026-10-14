/**
 * How both stores keep a value: as JSON. A stored value comes back without its `undefined`
 * fields and is otherwise the same, so the in-memory store behaves like DynamoDB.
 */
export function asStored(value: unknown): string {
  return JSON.stringify(value);
}

export function fromStored<T>(json: string): T {
  return JSON.parse(json) as T;
}

/** A stored copy: what reading the value back would give. */
export function copy<T>(value: T): T {
  return value === undefined ? value : fromStored<T>(asStored(value));
}
