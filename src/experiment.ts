import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Bench, Case } from './bench.ts';
import { pct } from './bench.ts';
import type { Device } from './device.ts';
import { Refusal } from './device.ts';
import { isCount, metricInfo } from './metrics.ts';
import { type RunResult, filmed, runOnce } from './run.ts';
import { type Comparison, LOOKS, MIN_PAIRS, POCOCK_LEVEL, compare, median } from './stats.ts';
import { type Experiment, type Series, type Variant, saveExperiment } from './store.ts';
import { get } from './util.ts';

export type BenchOptions = {
  device: Device;
  bench: Bench;
  file: string;
  cases: string[];
  base: Variant;
  head: Variant;
  /** A fixed number of pairs (one look at 95%), or the planned looks. */
  pairs: number | 'auto';
  runs?: number;
  warmup: number;
  dir: string;
  experiment: Experiment;
  log: (line: string) => void;
};

function caseOf(bench: Bench, name: string): Case {
  const c = bench.cases[name];
  if (!c) throw new Error(`no case ${name}`);
  return c;
}

type Block = { values: Record<string, number>; refused: Record<string, string> };

const DEFAULT_BOUND = 0.02;

async function install(o: BenchOptions, v: Variant): Promise<void> {
  if (v.artifact) await o.device.install(v.artifact);
  else if (!(await o.device.isInstalled(v.appId))) throw new Error(`${v.appId} is not installed on ${o.device.name}`);
}

/** One fresh block: the variant's app, `warmup` discarded runs, then `runs` measured ones (median per metric). */
async function block(o: BenchOptions, name: string, c: Case, v: Variant, tag: string): Promise<Block> {
  const sequential = o.base.appId === o.head.appId;
  if (sequential) await install(o, v);
  const tap = await o.device.logs(v.appId);
  const offset = await o.device.clockOffset();
  const runs: RunResult[] = [];
  try {
    const total = o.warmup + (c.runs ?? o.runs ?? o.bench.runs ?? 3);
    for (let i = 0; i < total; i++) {
      const video = filmed(c) ? join(o.dir, 'video', `${tag}-${v.role}-${i}.mp4`) : undefined;
      if (video) await mkdir(dirname(video), { recursive: true });
      const result = await runOnce({
        device: o.device,
        appId: v.appId,
        bench: o.bench,
        case: c,
        tap,
        offset,
        dir: dirname(o.file),
        video,
      });
      await appendFile(
        join(o.dir, 'runs.ndjson'),
        `${JSON.stringify({ case: name, block: tag, role: v.role, run: i, warmup: i < o.warmup, ...result })}\n`,
      );
      if (i >= o.warmup) runs.push(result);
    }
  } finally {
    await tap.stop();
    await o.device.terminate(v.appId);
  }
  const values: Record<string, number> = {};
  const refused: Record<string, string> = {};
  const names = new Set(runs.flatMap((r) => [...Object.keys(r.values), ...Object.keys(r.refused)]));
  for (const metric of names) {
    const got = runs.map((r) => r.values[metric]).filter((x): x is number => x !== undefined);
    if (got.length === runs.length) values[metric] = median(got);
    else
      refused[metric] =
        runs.map((r) => r.refused[metric]).find(Boolean) ??
        `missing in ${runs.length - got.length} of ${runs.length} runs`;
  }
  return { values, refused };
}

function comparisonOf(metric: string, pairs: [Block, Block][], level: number, bound: number): Comparison | null {
  const info = metricInfo(metric);
  if (!info) return null;
  const usable = pairs.filter(([b, h]) => b.values[metric] !== undefined && h.values[metric] !== undefined);
  if (usable.length < 2) return null;
  return compare(
    usable.map(([b]) => b.values[metric] ?? Number.NaN),
    usable.map(([, h]) => h.values[metric] ?? Number.NaN),
    { metric, better: info.better, ratio: !isCount(metric), count: isCount(metric), level, bound },
  );
}

function isLook(n: number, o: BenchOptions): boolean {
  return o.pairs === 'auto' ? (LOOKS as readonly number[]).includes(n) : n === o.pairs;
}

/** Runs one case as a series: a discarded block per side, then alternating pairs until a look decides. */
async function series(o: BenchOptions, name: string): Promise<Series> {
  const c = caseOf(o.bench, name);
  const bound = c.bound ? pct(c.bound) : DEFAULT_BOUND;
  const maxPairs = o.pairs === 'auto' ? get(LOOKS, LOOKS.length - 1) : o.pairs;
  const level = o.pairs === 'auto' ? POCOCK_LEVEL : 0.95;
  const pairs: [Block, Block][] = [];
  const started = Date.now();
  let stopped = `${maxPairs} pairs`;
  let primary: Comparison | null = null;

  o.log(`${name}: warm-up blocks (discarded)`);
  await block(o, name, c, o.base, 'warm');
  await block(o, name, c, o.head, 'warm');

  for (let i = 0; i < maxPairs; i++) {
    const order = i % 2 === 0 ? [o.base, o.head] : [o.head, o.base];
    const first = await block(o, name, c, get(order, 0), `p${i}`);
    const second = await block(o, name, c, get(order, 1), `p${i}`);
    const pair: [Block, Block] = i % 2 === 0 ? [first, second] : [second, first];
    pairs.push(pair);
    const refusal = pair[0].refused[c.primary] ?? pair[1].refused[c.primary];
    if (refusal) throw new Refusal('PrimaryRefused', `${name}: ${c.primary} refused: ${refusal}`);
    const b = pair[0].values[c.primary];
    const h = pair[1].values[c.primary];
    o.log(
      `${name}: pair ${i + 1}  base ${fmt(b)}  head ${fmt(h)}  ${b && h ? `${h >= b ? '+' : ''}${(((h - b) / b) * 100).toFixed(1)}%` : ''}`,
    );
    if (!isLook(pairs.length, o)) continue;
    primary = comparisonOf(c.primary, pairs, level, bound);
    if (!primary) continue;
    if (primary.decided) {
      stopped = `decided at ${pairs.length} pairs`;
      break;
    }
    if (
      o.pairs === 'auto' &&
      pairs.length >= 12 &&
      (primary.needed_pairs === null || primary.needed_pairs > maxPairs)
    ) {
      stopped = `underpowered at ${pairs.length} pairs`;
      break;
    }
  }
  primary ??= comparisonOf(c.primary, pairs, level, bound);
  if (!primary) throw new Refusal('PrimaryRefused', `${name}: no values for ${c.primary}`);

  const declared = new Set(c.metrics ?? []);
  const others = [...new Set(pairs.flatMap(([b, h]) => [...Object.keys(b.values), ...Object.keys(h.values)]))].filter(
    (m) => m !== c.primary,
  );
  // Declared secondaries are tested at a Bonferroni level (95% overall across them), so their direction and
  // equivalence claims are both corrected; the rest are descriptive intervals at 95%.
  const tests = Math.max(1, others.filter((m) => declared.has(m)).length);
  const secondaries = others
    .map((m) => comparisonOf(m, pairs, declared.has(m) ? 1 - 0.05 / tests : 0.95, bound))
    .filter((x): x is Comparison => x !== null);
  for (const s of secondaries) {
    if (s.exact) continue;
    if (!declared.has(s.metric) || !primary.decided) {
      s.verdict_kind = 'untested';
      s.decided = false;
    }
  }
  const refused: Record<string, string> = {};
  for (const [b, h] of pairs) for (const [m, why] of Object.entries({ ...b.refused, ...h.refused })) refused[m] ??= why;
  return {
    case: name,
    primary,
    secondaries,
    refused,
    pairs: pairs.length,
    stopped: primary.decided
      ? stopped
      : pairs.length < MIN_PAIRS
        ? `${pairs.length} pairs: fewer than ${MIN_PAIRS} never decide`
        : stopped,
    minutes: (Date.now() - started) / 60_000,
  };
}

function fmt(v: number | undefined): string {
  return v === undefined ? '—' : v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

export async function runBench(o: BenchOptions): Promise<Experiment> {
  if (o.base.appId === o.head.appId && (!o.base.artifact || !o.head.artifact))
    throw new Error(
      `base and head are both ${o.base.appId}: installing one replaces the other, so pass both as build files (or give them different bundle ids)`,
    );
  await saveExperiment(o.dir, o.experiment);
  await o.device.prepare();
  if (o.base.appId !== o.head.appId) await Promise.all([install(o, o.base), install(o, o.head)].map((p) => p));
  for (const name of o.cases) {
    const result = await series(o, name);
    o.experiment.series.push(result);
    await saveExperiment(o.dir, o.experiment);
  }
  o.experiment.decided = o.experiment.series.every((s) => s.primary.decided);
  await saveExperiment(o.dir, o.experiment);
  return o.experiment;
}

export async function runCheck(o: Omit<BenchOptions, 'base' | 'pairs' | 'warmup'>): Promise<Experiment> {
  await saveExperiment(o.dir, o.experiment);
  await o.device.prepare();
  for (const name of o.cases) {
    const c = caseOf(o.bench, name);
    const b = await block(
      { ...o, base: o.head, pairs: 1, warmup: 0, runs: 1 },
      name,
      { ...c, runs: 1 },
      o.head,
      'check',
    );
    o.experiment.checks.push({ case: name, values: b.values, refused: b.refused });
    o.log(
      `${name}: ${Object.keys(b.refused).includes(c.primary) ? `refused: ${b.refused[c.primary]}` : `${c.primary} ${fmt(b.values[c.primary])}`}`,
    );
  }
  await saveExperiment(o.dir, o.experiment);
  return o.experiment;
}
