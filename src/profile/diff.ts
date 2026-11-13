import { compare, median } from '../stats.ts';
import { type Cost, type Costs, type Profile, costs } from './model.ts';

// Base against head, per function and per module, over the profiled pairs. A row is called slower or faster
// only when the pairs agree as the bench's own metrics must: a bootstrap interval of the per-pair differences
// that clears zero and a signed-rank test below 5%, with at least 6 pairs, and a change big enough to matter.

/** A change smaller than this is never called, however consistent: a few samples' worth. */
const MIN_MS = 5;
/** Nor one under this share of the larger side's time. */
const MIN_SHARE = 0.05;
/** Rows tested and kept: the functions or modules with the most time on either side. */
const TOP = 25;

export type Change = {
  /** Medians over the pairs, ms. */
  base: number;
  head: number;
  /** Mean per-pair difference and its 95% interval, ms. */
  delta: number;
  lo: number;
  hi: number;
  /** Pairs in which head took more time, and pairs compared. */
  up: number;
  n: number;
  call?: 'slower' | 'faster';
};

export type DiffRow = { key: string; name: string; module: string; file?: string; self: Change; total: Change };

export type ProfileDiff = { pairs: number; ms: Change; functions: DiffRow[]; modules: DiffRow[] };

function change(base: number[], head: number[]): Change {
  const n = base.length;
  const c = compare(base, head, {
    metric: 'profile',
    better: 'lower',
    ratio: false,
    count: false,
    level: 0.95,
    bound: 0,
  });
  const [b, h] = [median(base), median(head)];
  const big = Math.abs(c.estimate) >= Math.max(MIN_MS, MIN_SHARE * Math.max(b, h));
  const call = !big
    ? undefined
    : c.verdict_kind === 'worse'
      ? 'slower'
      : c.verdict_kind === 'better'
        ? 'faster'
        : undefined;
  return {
    base: b,
    head: h,
    delta: c.estimate,
    lo: c.lo,
    hi: c.hi,
    up: base.filter((x, i) => (head[i] ?? 0) > x).length,
    n,
    ...(call && { call }),
  };
}

function rows(pairs: [Costs, Costs][], pick: (c: Costs) => Cost[]): DiffRow[] {
  const keys = new Map<string, { cost: Cost; weight: number }>();
  for (const [b, h] of pairs)
    for (const c of [...pick(b), ...pick(h)]) {
      const known = keys.get(c.key);
      keys.set(c.key, { cost: known?.cost ?? c, weight: Math.max(known?.weight ?? 0, c.total) });
    }
  const lookup = pairs.map(([b, h]) => [
    new Map(pick(b).map((c) => [c.key, c])),
    new Map(pick(h).map((c) => [c.key, c])),
  ]);
  const side = (i: 0 | 1, key: string, what: 'self' | 'total') => lookup.map((l) => l[i]?.get(key)?.[what] ?? 0);
  return [...keys.values()]
    .toSorted((a, b) => b.weight - a.weight)
    .slice(0, TOP)
    .map(({ cost }) => {
      const row: DiffRow = {
        key: cost.key,
        name: cost.name,
        module: cost.module,
        self: change(side(0, cost.key, 'self'), side(1, cost.key, 'self')),
        total: change(side(0, cost.key, 'total'), side(1, cost.key, 'total')),
      };
      if (cost.file) row.file = cost.file;
      return row;
    });
}

/** Pairs of profiles (base, head), one pair per profiled block pair. */
export function diffProfiles(pairs: readonly [Profile, Profile][]): ProfileDiff {
  const c = pairs.map(([b, h]): [Costs, Costs] => [costs(b), costs(h)]);
  return {
    pairs: pairs.length,
    ms: change(
      c.map(([b]) => b.ms),
      c.map(([, h]) => h.ms),
    ),
    functions: rows(c, (x) => x.functions),
    modules: rows(c, (x) => x.modules),
  };
}

/** Rows called slower or faster, the biggest change first, by total time and then by self time. */
export function called(diff: ProfileDiff, what: 'functions' | 'modules'): DiffRow[] {
  return diff[what]
    .filter((r) => r.total.call ?? r.self.call)
    .toSorted((a, b) => Math.abs(b.total.delta) - Math.abs(a.total.delta));
}
