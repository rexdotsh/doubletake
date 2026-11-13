import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { METRICS, metricInfo } from './metrics.ts';
import { PROBE_METRICS, type ProbeConfig, probeConfig } from './probe.ts';
import { get, isRecord } from './util.ts';

import type { Point, Target } from './device.ts';

export type Step =
  | 'launch'
  | 'terminate'
  | { open: string }
  | { wait: string; timeout?: string }
  | { sleep: string }
  | { tap: Point | Target }
  | { swipe: { from: Point; to: Point; duration?: string } }
  | { scroll: 'down' | 'up'; times?: number }
  | { maestro: string; env?: Record<string, string> }
  | { shell: string }
  | { repeat: Step[]; times: number };

export type Case = {
  /** The metric the verdict is about. */
  primary: string;
  /** More metrics to report; secondaries get words only after the primary decided. */
  metrics?: string[];
  /**
   * A cold launch per run: the app is terminated, launched and timed until `until` (a mark) or until the screen
   * settles. `timeline`: the platform's launch lines are marks too, and the gaps between marks are phases.
   */
  launch?: { until?: string; visual?: boolean; hold?: string; timeout?: string; timeline?: boolean };
  /** Untimed steps before each run. */
  setup?: Step[];
  /** Timed steps: the run. */
  run?: Step[];
  /** Sit on the screen `setup` left for this long and measure CPU per second. */
  idle?: string;
  /** Runs per block (median per block). */
  runs?: number;
  /** Equivalence bound for `same`, as a percentage. */
  bound?: string;
  /**
   * Noise floor, as a percentage: what an A/A run (one build against itself, or two builds of the same source)
   * moved this case's metrics. An interval inside ±floor reads `within noise`.
   */
  floor?: string;
};

export type Bench = {
  app: { ios?: string; android?: string };
  cases: Record<string, Case>;
  runs?: number;
  /**
   * iOS system prompt buttons to tap when a prompt covers the app (tracking, notifications), in order of
   * preference, such as `['Ask App Not to Track', 'Allow']`. `open` steps accept "Open in …?" on their own.
   */
  alerts?: string[];
  /** Fractions of the screen [x, y, w, h] that visual metrics ignore, such as a clock or a looping animation. */
  ignore?: [number, number, number, number][];
  /** Where `probe.*` metrics come from: Metro (CDP, dev clients) or a bridge in the app. */
  probe?: ProbeConfig;
};

export type CaseKind = 'launch' | 'run' | 'idle';

/** Every step, the ones inside repeats included. */
export function allSteps(flow: readonly Step[]): Step[] {
  return flow.flatMap((s) => (typeof s === 'object' && 'repeat' in s ? allSteps(s.repeat) : [s]));
}

export function caseKind(c: Case): CaseKind {
  if (c.launch) return 'launch';
  if (c.idle) return 'idle';
  return 'run';
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

export function ms(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text.trim());
  const unit = match?.[2] === undefined ? undefined : UNITS[match[2]];
  if (!match || unit === undefined) throw new Error(`a duration needs its unit (500ms, 2s, 1m, 2h): ${text}`);
  return Number(match[1]) * unit;
}

export function pct(text: string): number {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(text.trim());
  if (!match) throw new Error(`a bound is a percentage (2%): ${text}`);
  return Number(match[1]) / 100;
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next.push(Math.min(get(row, j) + 1, get(next, j - 1) + 1, get(row, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1)));
    row = next;
  }
  return get(row, b.length);
}

function nearest(key: string, known: readonly string[]): string {
  const [best] = known.map((k) => ({ k, d: distance(key, k) })).toSorted((a, b) => a.d - b.d);
  return best && best.d <= 3 ? ` (did you mean ${best.k}?)` : ` (known: ${known.join(', ')})`;
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${where}: expected an object`);
  return value;
}

function keys(value: Record<string, unknown>, known: readonly string[], where: string): void {
  for (const key of Object.keys(value))
    if (!known.includes(key)) throw new Error(`${where}: unknown key ${key}${nearest(key, known)}`);
}

function string(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where}: expected a string`);
  return value;
}

function optional<T>(value: unknown, parse: (v: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where}: expected a list`);
  return value;
}

function count(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new Error(`${where}: expected a whole number ≥ 1`);
  return value;
}

function pair(value: unknown, where: string): [number, number] {
  const [x, y, ...rest] = list(value, where);
  if (!Number.isFinite(x) || !Number.isFinite(y) || Number(x) < 0 || Number(y) < 0 || rest.length)
    throw new Error(`${where}: a point is [x, y], two numbers ≥ 0`);
  return [Number(x), Number(y)];
}

function point(value: unknown, where: string): Point {
  if (isRecord(value)) return (keys(value, ['points'], where), { points: pair(value.points, where) });
  const at = pair(value, where);
  if (at.some((v) => v > 1))
    throw new Error(`${where}: [x, y] is fractions of the screen, 0 to 1; write { points: [x, y] } for points`);
  return at;
}

function index(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new Error(`${where}: index is a whole number ≥ 0 (0 is the first match)`);
  return value;
}

function tapAt(value: unknown, where: string): Point | Target {
  if (typeof value === 'string') return value;
  if (isRecord(value) && 'id' in value)
    return (keys(value, ['id', 'index'], where), { id: string(value.id, where), index: index(value.index, where) });
  if (isRecord(value) && 'label' in value)
    return (
      keys(value, ['label', 'index'], where), { label: string(value.label, where), index: index(value.index, where) }
    );
  return point(value, where);
}

function duration(value: unknown, where: string): string {
  ms(string(value, where));
  return string(value, where);
}

function mark(value: unknown, where: string): string {
  const text = string(value, where);
  if (!text.startsWith('mark:')) throw new Error(`${where}: expected mark:<name>`);
  return text;
}

function parseStep(value: unknown, where: string): Step {
  if (value === 'launch' || value === 'terminate') return value;
  const s = object(value, where);
  if ('open' in s) return (keys(s, ['open'], where), { open: string(s.open, where) });
  if ('wait' in s)
    return (
      keys(s, ['wait', 'timeout'], where),
      { wait: mark(s.wait, where), timeout: optional(s.timeout, (v) => duration(v, where)) }
    );
  if ('sleep' in s) return (keys(s, ['sleep'], where), { sleep: duration(s.sleep, where) });
  if ('tap' in s) return (keys(s, ['tap'], where), { tap: tapAt(s.tap, where) });
  if ('swipe' in s) {
    keys(s, ['swipe'], where);
    const sw = object(s.swipe, `${where}.swipe`);
    keys(sw, ['from', 'to', 'duration'], `${where}.swipe`);
    return {
      swipe: {
        from: point(sw.from, where),
        to: point(sw.to, where),
        duration: optional(sw.duration, (v) => duration(v, where)),
      },
    };
  }
  if ('scroll' in s) {
    keys(s, ['scroll', 'times'], where);
    if (s.scroll !== 'down' && s.scroll !== 'up') throw new Error(`${where}: scroll is down or up`);
    return { scroll: s.scroll, times: optional(s.times, (v) => count(v, where)) };
  }
  if ('maestro' in s) {
    keys(s, ['maestro', 'env'], where);
    const env =
      s.env === undefined
        ? undefined
        : Object.fromEntries(Object.entries(object(s.env, where)).map(([k, v]) => [k, string(v, where)]));
    return { maestro: string(s.maestro, where), env };
  }
  if ('shell' in s) return (keys(s, ['shell'], where), { shell: string(s.shell, where) });
  if ('repeat' in s) {
    keys(s, ['repeat', 'times'], where);
    const body = steps(s.repeat, `${where}.repeat`);
    if (!body.length) throw new Error(`${where}.repeat: at least one step`);
    return { repeat: body, times: count(s.times, `${where}.times`) };
  }
  throw new Error(
    `${where}: a step is "launch", "terminate" or one of open, wait, sleep, tap, swipe, scroll, maestro, shell, repeat`,
  );
}

function metric(value: unknown, where: string): string {
  const name = string(value, where);
  if (!metricInfo(name))
    throw new Error(
      `${where}: unknown metric ${name}${nearest(name, [...Object.keys(METRICS), 'mark.<name>', 'phase.<from>-><to>'])}`,
    );
  return name;
}

function steps(value: unknown, where: string): Step[] {
  return list(value, where).map((step, i) => parseStep(step, `${where}[${i}]`));
}

function parseCase(value: unknown, where: string): Case {
  const c = object(value, where);
  keys(c, ['primary', 'metrics', 'launch', 'setup', 'run', 'idle', 'runs', 'bound', 'floor'], where);
  const kinds = ['launch', 'run', 'idle'].filter((k) => c[k] !== undefined);
  if (kinds.length !== 1) throw new Error(`${where}: a case has exactly one of launch, run or idle`);
  let launch: Case['launch'];
  if (c.launch !== undefined) {
    const l = object(c.launch, `${where}.launch`);
    keys(l, ['until', 'visual', 'hold', 'timeout', 'timeline'], `${where}.launch`);
    for (const flag of ['visual', 'timeline'])
      if (l[flag] !== undefined && typeof l[flag] !== 'boolean')
        throw new Error(`${where}.launch.${flag}: true or false`);
    launch = {
      until: optional(l.until, (v) => mark(v, `${where}.launch.until`)),
      visual: l.visual === undefined ? undefined : l.visual === true,
      timeline: l.timeline === undefined ? undefined : l.timeline === true,
      hold: optional(l.hold, (v) => duration(v, `${where}.launch.hold`)),
      timeout: optional(l.timeout, (v) => duration(v, `${where}.launch.timeout`)),
    };
  }
  return {
    primary: metric(c.primary, `${where}.primary`),
    metrics: optional(c.metrics, (v) => list(v, `${where}.metrics`).map((m) => metric(m, `${where}.metrics`))),
    launch,
    setup: optional(c.setup, (v) => steps(v, `${where}.setup`)),
    run: optional(c.run, (v) => steps(v, `${where}.run`)),
    idle: optional(c.idle, (v) => duration(v, `${where}.idle`)),
    runs: optional(c.runs, (v) => count(v, `${where}.runs`)),
    bound: optional(c.bound, (v) => (pct(string(v, `${where}.bound`)), string(v, `${where}.bound`))),
    floor: optional(c.floor, (v) => (pct(string(v, `${where}.floor`)), string(v, `${where}.floor`))),
  };
}

function region(value: unknown, where: string): [number, number, number, number] {
  const r = list(value, where);
  const [x, y, w, h] = r;
  if (r.length !== 4 || ![x, y, w, h].every((n) => typeof n === 'number' && n >= 0 && n <= 1))
    throw new Error(`${where}: a region is [x, y, w, h] in fractions of the screen`);
  return [Number(x), Number(y), Number(w), Number(h)];
}

/** Parses an untrusted bench object once, at the edge, into a typed bench. */
export function validate(raw: unknown): Bench {
  const bench = object(raw, 'bench');
  keys(bench, ['app', 'cases', 'runs', 'alerts', 'ignore', 'probe'], 'bench');
  const app = object(bench.app ?? {}, 'app');
  keys(app, ['ios', 'android'], 'app');
  const cases = object(bench.cases, 'cases');
  if (Object.keys(cases).length === 0) throw new Error('cases: at least one case');
  const parsed = Object.fromEntries(Object.entries(cases).map(([name, c]) => [name, parseCase(c, `cases["${name}"]`)]));
  for (const [name, c] of Object.entries(parsed)) {
    const probed = [c.primary, ...(c.metrics ?? [])].filter((m) => PROBE_METRICS.includes(m));
    if (!probed.length) continue;
    if (bench.probe === undefined)
      throw new Error(`cases["${name}"]: ${probed.join(', ')} need the bench's probe (cdp or bridge)`);
    if (c.launch) throw new Error(`cases["${name}"]: probe metrics are for run and idle cases`);
  }
  return {
    app: {
      ios: optional(app.ios, (v) => string(v, 'app.ios')),
      android: optional(app.android, (v) => string(v, 'app.android')),
    },
    cases: parsed,
    runs: optional(bench.runs, (v) => count(v, 'runs')),
    alerts: optional(bench.alerts, (v) => list(v, 'alerts').map((b, i) => string(b, `alerts[${i}]`))),
    ignore: optional(bench.ignore, (v) => list(v, 'ignore').map((r, i) => region(r, `ignore[${i}]`))),
    probe: optional(bench.probe, probeConfig),
  };
}

export async function loadBench(file: string): Promise<Bench> {
  const path = resolve(file);
  if (path.endsWith('.json')) return validate(JSON.parse(await readFile(path, 'utf8')));
  const mod: unknown = await import(pathToFileURL(path).href);
  return validate(isRecord(mod) ? mod.default : undefined);
}
