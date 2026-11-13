import type { SdkEvent } from './events.ts';
import { median } from './stats.ts';

// A launch's timeline: the platform's own log lines (React Native starts, JS runs, the first frame) and the
// app's marks, each timed from the launch. A phase is the gap between two consecutive marks, in the order
// they happened in that launch; a mark a launch did not write is missing there, never filled in.

/** The launch itself: the intent on Android, the process's exec on iOS. Every mark is ms after it. */
const ORIGIN = 'start';

type Mark = Extract<SdkEvent, { kind: 'mark' }>;
type OsMark = 'rn.start' | 'js.load' | 'js.run' | 'first.frame' | 'splash.removed' | 'fully.drawn';
const os = (name: OsMark, t: number, pid?: number): Mark => ({
  kind: 'mark',
  t,
  name,
  os: true,
  ...(pid !== undefined && { pid }),
});

/** A `logcat -v epoch` line: "<seconds.ms>  <pid>  <tid> <level> <tag>: <message>". */
export function logcatLine(line: string): { t: number; pid: number; tag: string; message: string } | null {
  const m = /^\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+[VDIWEF]\s+(.*?)\s*: (.*)$/.exec(line);
  if (!m?.[1] || !m[2] || m[3] === undefined || m[4] === undefined) return null;
  return { t: Number(m[1]) * 1000, pid: Number(m[2]), tag: m[3], message: m[4] };
}

/**
 * The Android system's and React Native's lines that mark a launch of `pkg`, timed by logcat. The system's
 * lines are written by system_server, so they carry no app pid. No process-start mark: ActivityManager logs
 * the fork within a few ms of the intent, as often before it as after, so the timeline starts at the intent.
 */
export function androidMark(line: string, pkg: string): Mark | null {
  const l = logcatLine(line);
  if (!l) return null;
  const { t, tag, message } = l;
  if (tag === 'ActivityTaskManager' && message.includes(` ${pkg}/`)) {
    if (message.startsWith('Displayed ')) return os('first.frame', t);
    if (message.startsWith('Fully drawn ')) return os('fully.drawn', t);
    return null;
  }
  // React Native's AppRegistry logs `Running "<app key>"` when the bundle has run and the root mounts.
  if (tag === 'ReactNativeJS' && message.startsWith('Running "')) return os('js.run', t, l.pid);
  // React Native's bridgeless host (the new architecture) logs creating its instance and loading the bundle.
  if (tag.endsWith('BridgelessReact')) {
    if (message.endsWith('getOrCreateReactInstanceTask(): Start')) return os('rn.start', t, l.pid);
    if (message.endsWith('getOrCreateReactInstanceTask(): Loading JS Bundle')) return os('js.load', t, l.pid);
    return null;
  }
  // Android 12+ removes the system splash (the starting window) from the app's process.
  if (tag === 'SplashScreenView' && message === 'remove starting view') return os('splash.removed', t, l.pid);
  return null;
}

/** A log stream ndjson timestamp, "2026-11-13 10:00:00.123456+0100", to epoch ms. */
export function osLogTime(text: string): number {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?([+-]\d\d)(\d\d)$/.exec(text.trim());
  if (!m) return Number.NaN;
  const whole = Date.parse(`${m[1]}T${m[2]}${m[4]}:${m[5]}`);
  return whole + Number(m[3] ?? 0) * 1000;
}

/** React Native's lines on iOS that mark a launch, from the app's own process, timed by the log. */
export function iosMark(message: string, t: number, pid?: number): Mark | null {
  if (/\bRunning "[^"]+"/.test(message)) return os('js.run', t, pid);
  return null;
}

/** Each mark's first time in a launch, ms after it, and the phases between consecutive marks. */
export function phasesOf(marks: ReadonlyMap<string, number>): { from: string; to: string; ms: number }[] {
  const ordered = [...marks].filter(([, at]) => at >= 0).toSorted((a, b) => a[1] - b[1]);
  let from = ORIGIN;
  let previous = 0;
  return ordered.map(([to, at]) => {
    const phase = { from, to, ms: at - previous };
    from = to;
    previous = at;
    return phase;
  });
}

export const phaseMetric = (from: string, to: string) => `phase.${from}->${to}`;

/**
 * Why a run has no value for a declared phase: an endpoint it did not write, or endpoints that were not
 * consecutive (reversed, or other marks between them). Mark times are ms after the launch.
 */
export function phaseRefusal(metric: string, marks: ReadonlyMap<string, number>): string {
  const [from = '', to = ''] = metric.slice('phase.'.length).split('->');
  const at = (name: string) => (name === ORIGIN ? 0 : marks.get(name));
  const missing = [from, to].filter((name) => (at(name) ?? -1) < 0);
  if (missing.length) return `NoMarker: the run wrote no ${missing.join(' or ')} mark`;
  const [begin = 0, end = 0] = [at(from), at(to)];
  if (end < begin) return `NotAPhase: ${to} came before ${from} in this run`;
  const between = [...marks].filter(([name, t]) => name !== from && name !== to && t >= begin && t <= end);
  return `NotAPhase: ${between.map(([name]) => name).join(', ') || 'another mark at the same time'} came between ${from} and ${to} in this run`;
}

export type Waterfall = {
  launches: number;
  /** Each mark's median time after the launch, in that order, and how many launches wrote it. */
  marks: { name: string; at: number; n: number }[];
  /**
   * Each directed phase as launches had it (consecutive marks in that launch), by its median start: `start`
   * is the median time of `from` in those launches, `ms` the median gap, `n` how many launches had it.
   */
  phases: { from: string; to: string; start: number; ms: number; n: number }[];
  /** The orders launches wrote their marks in, the most common first: more than one means phases differ. */
  orders: { marks: string[]; n: number }[];
};

/** The median waterfall of launches, each given as its marks (`name` to ms after the launch). */
export function waterfall(launches: readonly Record<string, number>[]): Waterfall {
  const names = [...new Set(launches.flatMap((l) => Object.keys(l)))];
  const marks = names
    .map((name) => {
      const at = launches.map((l) => l[name]).filter((x): x is number => x !== undefined);
      return { name, at: median(at), n: at.length };
    })
    .toSorted((a, b) => a.at - b.at);
  const pairs = new Map<string, { from: string; to: string; starts: number[]; gaps: number[] }>();
  const orders = new Map<string, { marks: string[]; n: number }>();
  for (const launch of launches) {
    const phases = phasesOf(new Map(Object.entries(launch)));
    let start = 0;
    for (const p of phases) {
      const key = phaseMetric(p.from, p.to);
      const pair = pairs.get(key) ?? { from: p.from, to: p.to, starts: [], gaps: [] };
      pair.starts.push(start);
      pair.gaps.push(p.ms);
      pairs.set(key, pair);
      start += p.ms;
    }
    const order = phases.map((p) => p.to);
    const known = orders.get(order.join('\n')) ?? { marks: order, n: 0 };
    known.n++;
    orders.set(order.join('\n'), known);
  }
  const phases = [...pairs.values()]
    .map((p) => ({ from: p.from, to: p.to, start: median(p.starts), ms: median(p.gaps), n: p.gaps.length }))
    .toSorted((a, b) => a.start - b.start || b.n - a.n);
  return { launches: launches.length, marks, phases, orders: [...orders.values()].toSorted((a, b) => b.n - a.n) };
}
