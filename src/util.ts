/** `list[i]`, for an index the caller knows is in range. */
export function get<T>(list: ArrayLike<T>, i: number): T {
  const v = list[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range (${list.length})`);
  return v;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a path of keys from parsed JSON, or undefined when any step is missing. */
export function dig(value: unknown, ...path: (string | number)[]): unknown {
  let at = value;
  for (const key of path) {
    if (Array.isArray(at) && typeof key === 'number') at = at[key];
    else if (isRecord(at) && typeof key === 'string') at = at[key];
    else return undefined;
  }
  return at;
}
