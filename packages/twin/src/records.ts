// Records parsed from JSON are plain objects, so `record[key]` and `key in record` also see
// Object.prototype ("toString", "constructor"). Plan input reaches these lookups, so use these.

/** The record's own value for `key`, ignoring anything inherited. */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Whether the record itself has `key`, ignoring anything inherited. */
export function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(record, key);
}
