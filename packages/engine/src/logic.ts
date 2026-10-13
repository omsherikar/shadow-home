// Kleene three-valued logic. "unknown" spreads only when the answer depends on it:
// false AND unknown is false, true OR unknown is true.

export type Truth = boolean | 'unknown';

export function and(...xs: Truth[]): Truth {
  let unknown = false;
  for (const x of xs) {
    if (x === false) return false;
    if (x === 'unknown') unknown = true;
  }
  return unknown ? 'unknown' : true;
}

export function or(...xs: Truth[]): Truth {
  let unknown = false;
  for (const x of xs) {
    if (x === true) return true;
    if (x === 'unknown') unknown = true;
  }
  return unknown ? 'unknown' : false;
}

export function not(x: Truth): Truth {
  return x === 'unknown' ? 'unknown' : !x;
}
