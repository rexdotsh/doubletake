import type { Better } from './metrics.ts';
import { get } from './util.ts';

type VerdictKind = 'better' | 'worse' | 'same' | 'noise' | 'unclear' | 'underpowered' | 'untested';

export type Comparison = {
  metric: string;
  n: number;
  base: number;
  head: number;
  /** Relative change (head / base − 1) when relative, else head − base in the metric's unit. */
  estimate: number;
  lo: number;
  hi: number;
  relative: boolean;
  /** The interval's nominal coverage. */
  confidence: number;
  /** Two-sided Wilcoxon signed-rank p on the pair differences. */
  p: number;
  /** The equivalence bound, in the same scale as the estimate. */
  bound: number;
  /** The case's noise floor (relative): a change this small is `noise`, whatever its interval says. */
  floor?: number;
  better: Better;
  verdict_kind: VerdictKind;
  decided: boolean;
  /** Pairs for an 80% chance of a verdict at this effect and spread; null when no effect is in reach. */
  needed_pairs: number | null;
  exact?: true;
};

/** Pairs below this never get a verdict: a bootstrap of five differences cannot reach 95% coverage. */
export const MIN_PAIRS = 6;
/** Planned looks for `--pairs auto`, as strobe's: each look's interval is at Pocock's constant level. */
export const LOOKS = [8, 12, 18, 26, 40] as const;
export const POCOCK_LEVEL = 0.9842;

export function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length === 0) return Number.NaN;
  return sorted.length % 2 ? get(sorted, mid) : (get(sorted, mid - 1) + get(sorted, mid)) / 2;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Robust spread: 1.4826 × MAD, or the mean absolute deviation × √(π/2) when over half the values tie. */
function spread(values: readonly number[]): number {
  const m = median(values);
  const deviations = values.map((v) => Math.abs(v - m));
  const mad = 1.4826 * median(deviations);
  return mad > 0 ? mad : mean(deviations) * Math.sqrt(Math.PI / 2);
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const poly = (k: number[], x: number) => k.reduce((acc, v) => acc * x + v, 0);

/** Inverse standard normal CDF (Acklam). */
export function zQuantile(p: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239,
  ];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    return poly(c, q) / (poly(d, q) * q + 1);
  }
  if (p > 1 - 0.02425) return -zQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (poly(a, r) * q) / (poly(b, r) * r + 1);
}

function normalCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26 on erf, enough for an interval's tail level.
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Student t quantile by the Cornish–Fisher expansion (Hill 1970), accurate to ~1e-4 from 3 degrees of freedom. */
export function tQuantile(p: number, df: number): number {
  const z = zQuantile(p);
  const z3 = z ** 3;
  const z5 = z ** 5;
  const z7 = z ** 7;
  const z9 = z ** 9;
  return (
    z +
    (z3 + z) / (4 * df) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3) +
    (79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / (92160 * df ** 4)
  );
}

/**
 * Bootstrap interval of the mean difference. A plain percentile bootstrap covers too little with few pairs,
 * so the tail level is widened as Hesterberg's expanded percentile interval does: α' = 2Φ(−√(n/(n−1))·t(α/2, n−1)).
 */
export function bootstrapInterval(d: readonly number[], level: number, seed = 1, resamples = 10_000): [number, number] {
  const n = d.length;
  const alpha = 1 - level;
  const widened = 2 * normalCdf(-Math.sqrt(n / (n - 1)) * tQuantile(1 - alpha / 2, n - 1));
  const random = rng(seed);
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += get(d, Math.floor(random() * n));
    means[r] = sum / n;
  }
  means.sort();
  const at = (q: number) => get(means, Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples))));
  return [at(widened / 2), at(1 - widened / 2)];
}

/** Two-sided Wilcoxon signed-rank p, exact by enumeration of the ranks (zeros dropped, ties at mid-rank). */
export function signedRankP(d: readonly number[]): number {
  const nonzero = d.filter((v) => v !== 0);
  const n = nonzero.length;
  if (n === 0) return 1;
  const order = nonzero.map((v, i) => ({ abs: Math.abs(v), i })).toSorted((a, b) => a.abs - b.abs);
  const ranks = Array.from({ length: n }, () => 0);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && get(order, j + 1).abs === get(order, i).abs) j++;
    for (let k = i; k <= j; k++) ranks[get(order, k).i] = (i + j + 2) / 2;
    i = j + 1;
  }
  // Doubled ranks are integers, so the null distribution of 2·W+ is a subset-sum count.
  const doubled = ranks.map((r) => Math.round(r * 2));
  const total = doubled.reduce((s, r) => s + r, 0);
  let wPlus = 0;
  nonzero.forEach((v, i) => {
    if (v > 0) wPlus += get(doubled, i);
  });
  const counts = new Float64Array(total + 1);
  counts[0] = 1;
  for (const r of doubled) for (let s = total; s >= r; s--) counts[s] = get(counts, s) + get(counts, s - r);
  const all = 2 ** n;
  const tail = Math.min(wPlus, total - wPlus);
  let below = 0;
  for (let s = 0; s <= tail; s++) below += get(counts, s);
  return Math.min(1, (2 * below) / all);
}

export type CompareOptions = {
  metric: string;
  better: Better;
  /** Compare log ratios (ratio metrics with positive values) or plain differences. */
  ratio: boolean;
  /** A count compares exactly when every block on a side reads the same value. */
  count: boolean;
  level: number;
  bound: number;
  /** Relative: an interval inside ±floor is `noise`; a direction whose estimate is under it is `unclear`. */
  floor?: number;
  seed?: number;
};

function toRelative(x: number, ratio: boolean): number {
  return ratio ? Math.expm1(x) : x;
}

function neededPairs(d: readonly number[], boundScaled: number, level: number): number | null {
  const sigma = spread(d);
  const effect = Math.abs(median(d));
  const z = zQuantile(1 - (1 - level) / 2) + zQuantile(0.8);
  const candidates = [effect, boundScaled - effect].filter((distance) => distance > 0);
  if (sigma === 0) return MIN_PAIRS;
  const best = Math.min(...candidates.map((distance) => ((z * sigma) / distance) ** 2));
  return Number.isFinite(best) ? Math.max(MIN_PAIRS, Math.ceil(best)) : null;
}

/** Compares one metric over paired blocks: `base[i]` and `head[i]` are pair i's block values. */
export function compare(base: readonly number[], head: readonly number[], o: CompareOptions): Comparison {
  const n = base.length;
  const ratio = o.ratio && [...base, ...head].every((v) => v > 0);
  const d = base.map((b, i) => (ratio ? Math.log(get(head, i) / b) : get(head, i) - b));
  const baseMedian = median(base);
  const headMedian = median(head);
  const boundScaled = ratio
    ? Math.log1p(o.bound)
    : Math.max(o.bound * Math.abs(baseMedian || headMedian), o.count ? 0.5 : 0);
  const common = {
    metric: o.metric,
    n,
    base: baseMedian,
    head: headMedian,
    relative: ratio,
    confidence: o.level,
    better: o.better,
  };
  const sign = o.better === 'lower' ? 1 : -1;

  if (o.count && n >= MIN_PAIRS && new Set(base).size === 1 && new Set(head).size === 1) {
    const diff = headMedian - baseMedian;
    const kind: VerdictKind = diff === 0 ? 'same' : diff * sign < 0 ? 'better' : 'worse';
    const estimate = ratio ? headMedian / baseMedian - 1 : diff;
    return {
      ...common,
      estimate,
      lo: estimate,
      hi: estimate,
      p: diff === 0 ? 1 : 0,
      bound: 0,
      verdict_kind: kind,
      decided: true,
      needed_pairs: null,
      exact: true,
    };
  }

  const p = signedRankP(d);
  const [lo, hi] = n >= 2 ? bootstrapInterval(d, o.level, o.seed) : [Number.NaN, Number.NaN];
  const estimate = toRelative(mean(d), ratio);
  const interval = {
    estimate,
    lo: toRelative(lo, ratio),
    hi: toRelative(hi, ratio),
    p,
    bound: ratio ? o.bound : boundScaled,
  };
  // With a floor, the band an interval must fit (or clear) is the wider of the bound and the floor.
  const band = o.floor !== undefined && ratio ? Math.max(boundScaled, Math.log1p(o.floor)) : boundScaled;
  const needed = n >= 2 ? neededPairs(d, band, o.level) : null;
  if (n < MIN_PAIRS)
    return { ...common, ...interval, verdict_kind: 'underpowered', decided: false, needed_pairs: needed };

  let kind: VerdictKind = 'unclear';
  // A direction needs the bootstrap interval to clear 0 and the signed-rank test to agree: the mean's
  // bootstrap alone ran to ~6.5% false calls in A/A simulations with heavy-tailed (t3) noise.
  const significant = p < 1 - o.level;
  if (hi < 0 && significant) kind = sign > 0 ? 'better' : 'worse';
  else if (lo > 0 && significant) kind = sign > 0 ? 'worse' : 'better';
  else if ((lo > -boundScaled && hi < boundScaled) || (lo === 0 && hi === 0)) kind = 'same';
  else if (needed === null || needed > n) kind = 'underpowered';
  // A floor measured by an A/A run: the build pipeline and device move a metric this much with no code change.
  if (o.floor !== undefined && ratio && kind !== 'same') {
    const f = Math.log1p(o.floor);
    // Within noise only when the whole interval is: like `same`, with the floor as the band. A direction whose
    // estimate is under the floor but whose interval reaches past it is not settled either way: more pairs.
    if (lo > -f && hi < f) kind = 'noise';
    else if ((kind === 'better' || kind === 'worse') && Math.abs(mean(d)) < f) kind = 'unclear';
  }
  const decided = kind === 'better' || kind === 'worse' || kind === 'same' || kind === 'noise';
  return {
    ...common,
    ...interval,
    ...(o.floor !== undefined && ratio && { floor: o.floor }),
    verdict_kind: kind,
    decided,
    needed_pairs: needed,
  };
}
