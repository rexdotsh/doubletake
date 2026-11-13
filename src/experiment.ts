import { appendFile, mkdir } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import type { Bench, Case } from './bench.ts';
import { pct } from './bench.ts';
import type { Device } from './device.ts';
import { Refusal } from './device.ts';
import { isCount, metricInfo } from './metrics.ts';
import { addByProgram, coresBetween, type Others, snapshot, summarize, watchOthers } from './host.ts';
import { type RunResult, filmed, runOnce } from './run.ts';
import { type Comparison, LOOKS, MIN_PAIRS, POCOCK_LEVEL, compare, median } from './stats.ts';
import { type Experiment, type Series, type Variant, lockDevice, saveExperiment } from './store.ts';
import { sleep } from './sh.ts';
import { type Clip, sideBySide } from './video.ts';
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
  /** Film one extra block per side of this case after the pairs and put them side by side. */
  video?: string;
  /** How long the experiment may wait for a quiet host in all, and how long it has. */
  queue: { budgetMs: number; waitedMs: number };
};

function caseOf(bench: Bench, name: string): Case {
  const c = bench.cases[name];
  if (!c) throw new Error(`no case ${name}`);
  return c;
}

/** A block's median per metric; `varying` names counts whose runs disagreed (never compared exactly). */
type Block = { values: Record<string, number>; refused: Record<string, string>; varying: Set<string> };

const DEFAULT_BOUND = 0.02;

/** Refusals that end one case and let the experiment go on with the next. */
const CASE_REFUSALS = new Set(['Background', 'PrimaryRefused']);

async function install(o: Pick<BenchOptions, 'device'>, v: Variant): Promise<void> {
  if (v.artifact) await o.device.install(v.artifact);
  else if (!(await o.device.isInstalled(v.appId))) throw new Error(`${v.appId} is not installed on ${o.device.name}`);
}

const busyWith = (top: Others['top']) =>
  top.map((t) => `${t.name} ${t.cores.toFixed(1)}`).join(', ') || 'nothing that stayed between samples';

/** Other processes using more than this share of the host's cores compete with the app for CPU. */
const BUSY_SHARE = 0.5;

const limit = () => cpus().length * BUSY_SHARE;

const isDevice = (o: Pick<BenchOptions, 'device'>) => (command: string) => o.device.isHostProcess(command);

/**
 * Waits until other processes use under half the host's cores over 5 s. All waits of one experiment share one
 * budget (`--queue`, 30 minutes by default); past it, the experiment is refused with what was measured.
 */
async function quiet(o: BenchOptions): Promise<void> {
  const started = Date.now();
  let said = false;
  for (;;) {
    const before = await snapshot(isDevice(o));
    await sleep(5000);
    const after = await snapshot(isDevice(o));
    const cores = coresBetween(before, after);
    const programs = new Map<string, number>();
    addByProgram(before, after, programs);
    const busy = busyWith(summarize([{ ms: after.at - before.at, cores, programs }]).top);
    const waited = Date.now() - started;
    if (cores <= limit()) {
      o.queue.waitedMs += waited;
      return;
    }
    if (o.queue.waitedMs + waited > o.queue.budgetMs) {
      // Spent: the next case refuses at its first busy sample instead of waiting the budget again.
      o.queue.waitedMs += waited;
      throw new Refusal(
        'Background',
        `other processes still used ${cores.toFixed(1)} of ${cpus().length} cores (limit ${limit()}; ${busy}) after ${Math.round(o.queue.waitedMs / 60_000)} min of waiting: run where nothing else runs, or wrap the bench in the host's lock; the runs so far are in runs.ndjson`,
      );
    }
    if (!said)
      o.log(
        `waiting for the host to go quiet: other processes use ${cores.toFixed(1)} cores (${busy}), limit ${limit()}`,
      );
    said = true;
    await sleep(10_000);
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Runs `measure` while sampling other processes' CPU, and appends what they used to `blocks.ndjson`, also when
 * the block fails.
 */
async function watched<T>(o: Pick<BenchOptions, 'device' | 'dir'>, at: object, measure: () => Promise<T>) {
  const watch = watchOthers(isDevice(o));
  const save = (others: Others, failed: boolean) =>
    appendFile(
      join(o.dir, 'blocks.ndjson'),
      `${JSON.stringify({ ...at, ...(failed && { failed }), others_mean_cores: round2(others.mean), others_busiest_5s_cores: round2(others.busiest), others_top: others.top.map((t) => ({ name: t.name, cores: round2(t.cores) })), others_busiest_top: others.busiestTop.map((t) => ({ name: t.name, cores: round2(t.cores) })), cores: cpus().length })}\n`,
    );
  const result = await measure().catch(async (error: unknown) => {
    await watch
      .stop()
      .then((others) => save(others, true))
      .catch(() => undefined);
    throw error;
  });
  const others = await watch.stop();
  await save(others, false);
  return { result, others };
}

/**
 * A block on a quiet host. Other work is sampled once a second through the block; when any 5-second stretch
 * used more than half the cores, the experiment is refused: a rerun of one side would give it launches its
 * pair-mate never had. Processes that start and end between two samples are not seen.
 */
async function block(o: BenchOptions, name: string, c: Case, v: Variant, tag: string): Promise<Block> {
  // Installing is outside the watched window: the simulator's and adb's host services do that work.
  if (o.base.appId === o.head.appId) await install(o, v);
  await quiet(o);
  const { result, others } = await watched(o, { case: name, block: tag, role: v.role }, () =>
    measureBlock(o, name, c, v, tag),
  );
  if (others.busiest > limit())
    throw new Refusal(
      'Background',
      `${name} ${tag} ${v.role}: other processes used ${others.busiest.toFixed(1)} of ${cpus().length} cores for 5 s during the block (in those 5 s, in cores: ${busyWith(others.busiestTop)}; over the block: ${busyWith(others.top)}): something else is using the machine`,
    );
  return result;
}

/** One fresh block: the variant's app, `warmup` discarded runs, then `runs` measured ones (median per metric). */
async function measureBlock(o: BenchOptions, name: string, c: Case, v: Variant, tag: string): Promise<Block> {
  const tap = await o.device.logs(v.appId);
  const offset = await o.device.clockOffset();
  const runs: RunResult[] = [];
  try {
    const total = o.warmup + (c.runs ?? o.runs ?? o.bench.runs ?? 3);
    for (let i = 0; i < total; i++) {
      // A check films every case under one tag: the case's place in the run keeps their videos apart.
      const clip = tag === 'check' ? `${tag}-${o.cases.indexOf(name)}-${name.replace(/[^\w-]+/g, '_')}` : tag;
      const video = filmed(c) ? join(o.dir, 'video', `${clip}-${v.role}-${i}.mp4`) : undefined;
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
  const varying = new Set<string>();
  const refused: Record<string, string> = {};
  const names = new Set(runs.flatMap((r) => [...Object.keys(r.values), ...Object.keys(r.refused)]));
  for (const metric of names) {
    const got = runs.map((r) => r.values[metric]).filter((x): x is number => x !== undefined);
    if (new Set(got).size > 1) varying.add(metric);
    if (got.length === runs.length) values[metric] = median(got);
    else
      refused[metric] =
        runs.map((r) => r.refused[metric]).find(Boolean) ??
        `missing in ${runs.length - got.length} of ${runs.length} runs`;
  }
  return { values, refused, varying };
}

function comparisonOf(
  metric: string,
  pairs: [Block, Block][],
  level: number,
  bound: number,
  floor?: number,
): Comparison | null {
  const info = metricInfo(metric);
  if (!info) return null;
  const usable = pairs.filter(([b, h]) => b.values[metric] !== undefined && h.values[metric] !== undefined);
  if (usable.length < 2) return null;
  return compare(
    usable.map(([b]) => b.values[metric] ?? Number.NaN),
    usable.map(([, h]) => h.values[metric] ?? Number.NaN),
    {
      metric,
      better: info.better,
      ratio: !isCount(metric),
      count: isCount(metric) && usable.every(([b, h]) => !b.varying.has(metric) && !h.varying.has(metric)),
      level,
      bound,
      floor,
    },
  );
}

function isLook(n: number, o: BenchOptions): boolean {
  return o.pairs === 'auto' ? (LOOKS as readonly number[]).includes(n) : n === o.pairs;
}

/** Runs one case as a series: a discarded block per side, then alternating pairs until a look decides. */
async function series(o: BenchOptions, name: string): Promise<Series> {
  const c = caseOf(o.bench, name);
  const bound = c.bound ? pct(c.bound) : DEFAULT_BOUND;
  const floor = c.floor ? pct(c.floor) : undefined;
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
    primary = comparisonOf(c.primary, pairs, level, bound, floor);
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
  primary ??= comparisonOf(c.primary, pairs, level, bound, floor);
  if (!primary) throw new Refusal('PrimaryRefused', `${name}: no values for ${c.primary}`);

  const declared = new Set(c.metrics ?? []);
  const others = [...new Set(pairs.flatMap(([b, h]) => [...Object.keys(b.values), ...Object.keys(h.values)]))].filter(
    (m) => m !== c.primary,
  );
  // Declared secondaries are tested at a Bonferroni level (95% overall across them), so their direction and
  // equivalence claims are both corrected; the rest are descriptive intervals at 95%.
  const tests = Math.max(1, others.filter((m) => declared.has(m)).length);
  const secondaries = others
    .map((m) => comparisonOf(m, pairs, declared.has(m) ? 1 - 0.05 / tests : 0.95, bound, floor))
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
    declared: [c.primary, ...(c.metrics ?? [])],
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

/** One filmed block per side, never timed: a warm run, then one recorded run, put side by side. */
async function film(o: BenchOptions, name: string): Promise<string> {
  const c = caseOf(o.bench, name);
  const clips: Clip[] = [];
  for (const v of [o.base, o.head]) {
    if (o.base.appId === o.head.appId) await install(o, v);
    const tap = await o.device.logs(v.appId);
    try {
      const offset = await o.device.clockOffset();
      const ctx = { device: o.device, appId: v.appId, bench: o.bench, case: c, tap, offset, dir: dirname(o.file) };
      await runOnce(ctx);
      await mkdir(join(o.dir, 'video'), { recursive: true });
      const result = await runOnce({ ...ctx, video: join(o.dir, 'video', `film-${v.role}.mp4`) });
      if (!result.video) throw new Error(`${name}: the filmed run gave no video`);
      clips.push({
        file: result.video.file,
        label: v.label,
        start: Math.max(0, result.video.first - 0.1),
        seconds: result.video.seconds,
      });
    } finally {
      await tap.stop();
      await o.device.terminate(v.appId);
    }
  }
  const [left, right] = clips;
  if (!left || !right) throw new Error('filming needs both sides');
  await sideBySide(left, right, join(o.dir, 'side-by-side.mp4'));
  return 'side-by-side.mp4';
}

export async function runBench(o: BenchOptions): Promise<Experiment> {
  const release = await lockDevice(o.device.id);
  try {
    return await benchLocked(o);
  } finally {
    await release();
  }
}

async function benchLocked(o: BenchOptions): Promise<Experiment> {
  if (o.base.appId === o.head.appId && (!o.base.artifact || !o.head.artifact))
    throw new Error(
      `base and head are both ${o.base.appId}: installing one replaces the other, so pass both as build files (or give them different bundle ids)`,
    );
  await saveExperiment(o.dir, o.experiment);
  await o.device.prepare();
  if (o.base.appId !== o.head.appId) await Promise.all([install(o, o.base), install(o, o.head)].map((p) => p));
  for (const name of o.cases) {
    try {
      o.experiment.series.push(await series(o, name));
    } catch (error) {
      // A busy host or a refused primary costs this case, not the ones after it: they get their own blocks and
      // guard. Other refusals (a missing marker, a broken recording) end the experiment, as any failure does.
      if (!(error instanceof Refusal) || !CASE_REFUSALS.has(error.validator)) throw error;
      o.log(`${name}: refused (${error.validator}): ${error.message}`);
      (o.experiment.refused_cases ??= []).push({ case: name, validator: error.validator, message: error.message });
    }
    await saveExperiment(o.dir, o.experiment);
  }
  o.experiment.decided = !o.experiment.refused_cases?.length && o.experiment.series.every((s) => s.primary.decided);
  if (o.video && o.experiment.refused_cases?.some((r) => r.case === o.video))
    o.log(`${o.video}: refused, so not filmed`);
  else if (o.video) {
    o.log(`${o.video}: filming one block per side`);
    o.experiment.video = await film(o, o.video);
  }
  await saveExperiment(o.dir, o.experiment);
  return o.experiment;
}

export async function runCheck(o: Omit<BenchOptions, 'base' | 'pairs' | 'warmup'>): Promise<Experiment> {
  const release = await lockDevice(o.device.id);
  try {
    return await check(o);
  } finally {
    await release();
  }
}

/**
 * One case of a check. A check answers "does each case work, and what does it read?", so a case that fails is
 * recorded (refused on its primary, with the error) and the next case still runs.
 */
export async function checkCase(
  primary: string,
  measure: () => Promise<{ values: Record<string, number>; refused: Record<string, string> }>,
): Promise<{ values: Record<string, number>; refused: Record<string, string> }> {
  try {
    return await measure();
  } catch (error) {
    const why =
      error instanceof Refusal
        ? `${error.validator}: ${error.message}`
        : `Failed: ${error instanceof Error ? error.message : String(error)}`;
    return { values: {}, refused: { [primary]: why } };
  }
}

async function check(o: Omit<BenchOptions, 'base' | 'pairs' | 'warmup'>): Promise<Experiment> {
  await saveExperiment(o.dir, o.experiment);
  await o.device.prepare();
  for (const name of o.cases) {
    const c = caseOf(o.bench, name);
    const b = await checkCase(c.primary, async () => {
      await install(o, o.head);
      const { result, others } = await watched(o, { case: name, block: 'check', role: o.head.role }, () =>
        measureBlock({ ...o, base: o.head, pairs: 1, warmup: 0, runs: 1 }, name, { ...c, runs: 1 }, o.head, 'check'),
      );
      // A check decides nothing, so a busy host is a warning on its values, never a wait or a refusal.
      if (others.busiest > limit())
        o.experiment.warnings.push(
          `${name}: other processes used ${others.busiest.toFixed(1)} of ${cpus().length} cores for 5 s during it (${busyWith(others.busiestTop)}): values from a busy machine`,
        );
      return result;
    });
    o.experiment.checks.push({ case: name, values: b.values, refused: b.refused });
    o.log(
      `${name}: ${Object.keys(b.refused).includes(c.primary) ? `refused: ${b.refused[c.primary]}` : `${c.primary} ${fmt(b.values[c.primary])}`}`,
    );
    // Saved after every case, so a check cut short keeps what it measured.
    await saveExperiment(o.dir, o.experiment);
  }
  return o.experiment;
}
