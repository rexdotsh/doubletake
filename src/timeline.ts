import type { SdkEvent } from './events.ts';
import { median } from './stats.ts';

// A launch's timeline: the platform's own log lines (the process starts, JS runs, the first frame) and the
// app's marks, each timed from the launch. A phase is the gap between two consecutive marks, in the order
// they happened in that launch; a mark a launch did not write is missing there, never filled in.

/** The launch itself: the intent on Android, the process's exec on iOS. Every mark is ms after it. */
const ORIGIN = 'start';

type Mark = Extract<SdkEvent, { kind: 'mark' }>;
type OsMark = 'process.start' | 'rn.start' | 'js.load' | 'js.run' | 'first.frame' | 'splash.removed' | 'fully.drawn';
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
 * lines are written by system_server: they carry the app's pid only where the message names it.
 */
export function androidMark(line: string, pkg: string): Mark | null {
  const l = logcatLine(line);
  if (!l) return null;
  const { t, tag, message } = l;
  if (tag === 'ActivityManager') {
    const start = /^Start proc (\d+):([\w.]+)\//.exec(message);
    return start?.[2] === pkg ? os('process.start', t, Number(start[1])) : null;
  }
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

export type Waterfall = {
  launches: number;
  /** Each mark's median time after the launch, in that order, and how many launches wrote it. */
  marks: { name: string; at: number; n: number }[];
  /** Consecutive marks in the median order: `start` is the median of `from`, `ms` the median gap. */
  phases: { from: string; to: string; start: number; ms: number; n: number }[];
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
  const phases = marks.map((to, i) => {
    const from = marks[i - 1];
    const gaps = launches.flatMap((l) => {
      const end = l[to.name];
      const begin = from ? l[from.name] : 0;
      return end === undefined || begin === undefined ? [] : [end - begin];
    });
    return { from: from?.name ?? ORIGIN, to: to.name, start: from?.at ?? 0, ms: median(gaps), n: gaps.length };
  });
  return { launches: launches.length, marks, phases };
}
