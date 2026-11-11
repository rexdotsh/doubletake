import { expect, test } from 'bun:test';
import {
  LOOKS,
  POCOCK_LEVEL,
  bootstrapInterval,
  compare,
  rng,
  signedRankP,
  tQuantile,
  zQuantile,
} from '../src/stats.ts';

function normal(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

/** Pairs of block values around 400 ms: head is `effect` slower or faster, with log-normal noise σ per block. */
function series(n: number, effect: number, sigma: number, random: () => number): [number[], number[]] {
  const base = Array.from({ length: n }, () => 400 * Math.exp(sigma * normal(random)));
  const head = Array.from({ length: n }, () => 400 * (1 + effect) * Math.exp(sigma * normal(random)));
  return [base, head];
}

const opts = { metric: 'launch.ttfd', better: 'lower' as const, ratio: true, count: false, level: 0.95, bound: 0.02 };

function verdicts(trials: number, n: number, effect: number, sigma: number, level = 0.95) {
  const random = rng(42);
  const tally = { better: 0, worse: 0, same: 0, other: 0 };
  for (let t = 0; t < trials; t++) {
    const [base, head] = series(n, effect, sigma, random);
    const kind = compare(base, head, { ...opts, level, seed: t }).verdict_kind;
    if (kind === 'better' || kind === 'worse' || kind === 'same') tally[kind]++;
    else tally.other++;
  }
  return tally;
}

test('quantiles match tables', () => {
  expect(zQuantile(0.975)).toBeCloseTo(1.96, 3);
  expect(tQuantile(0.975, 7)).toBeCloseTo(2.365, 2);
  expect(tQuantile(0.975, 30)).toBeCloseTo(2.042, 3);
});

test('signed-rank p is exact for small samples', () => {
  expect(signedRankP([1, 2, 3, 4, 5, 6])).toBeCloseTo(2 / 64, 10);
  expect(signedRankP([1, -2, 3, -4, 5, -6])).toBeGreaterThan(0.5);
  expect(signedRankP([0, 0, 0])).toBe(1);
});

test('an A/A at 8 pairs calls a difference in about 5% of experiments, not more', () => {
  const t = verdicts(1000, 8, 0, 0.03);
  const falsePositives = (t.better + t.worse) / 1000;
  expect(falsePositives).toBeLessThan(0.075);
});

test('A/A across the planned looks stays near 5% overall at the Pocock level', () => {
  const random = rng(7);
  let wrong = 0;
  const trials = 200;
  for (let t = 0; t < trials; t++) {
    const [base, head] = series(40, 0, 0.03, random);
    for (const look of LOOKS) {
      const c = compare(base.slice(0, look), head.slice(0, look), { ...opts, level: POCOCK_LEVEL, seed: t });
      if (c.verdict_kind === 'better' || c.verdict_kind === 'worse') {
        wrong++;
        break;
      }
      if (c.decided) break;
    }
  }
  expect(wrong / trials).toBeLessThan(0.08);
}, 120_000);

test('a 10% regression with 3% noise is called worse at 8 pairs', () => {
  const t = verdicts(300, 8, 0.1, 0.03);
  expect(t.worse / 300).toBeGreaterThan(0.95);
  expect(t.better).toBe(0);
});

test('no change with little noise is called same', () => {
  const t = verdicts(300, 12, 0, 0.005);
  expect(t.same / 300).toBeGreaterThan(0.9);
});

test('fewer than six pairs never get a verdict', () => {
  const c = compare([400, 410, 405], [300, 305, 310], opts);
  expect(c.verdict_kind).toBe('underpowered');
  expect(c.decided).toBe(false);
});

test('a stable count compares exactly', () => {
  const c = compare([3, 3, 3, 3, 3, 3], [2, 2, 2, 2, 2, 2], {
    ...opts,
    metric: 'net.requests',
    ratio: false,
    count: true,
  });
  expect(c.exact).toBe(true);
  expect(c.verdict_kind).toBe('better');
  expect(c.estimate).toBe(-1);
});

test('higher-is-better metrics flip the words', () => {
  const random = rng(3);
  const [base, head] = series(10, 0.2, 0.02, random);
  expect(compare(base, head, { ...opts, better: 'higher' }).verdict_kind).toBe('better');
});

test('the bootstrap interval is reproducible for a seed and widens for few pairs', () => {
  const d = [0.01, -0.02, 0.03, 0.0, 0.015, -0.01];
  expect(bootstrapInterval(d, 0.95, 9)).toEqual(bootstrapInterval(d, 0.95, 9));
  const [lo6, hi6] = bootstrapInterval(d, 0.95, 9);
  const [lo12, hi12] = bootstrapInterval([...d, ...d], 0.95, 9);
  expect(hi6 - lo6).toBeGreaterThan(hi12 - lo12);
});

test('eight identical zero pairs are the same, not unclear', () => {
  const c = compare([0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0], { ...opts, metric: 'js.stall', ratio: false });
  expect(c.verdict_kind).toBe('same');
});
