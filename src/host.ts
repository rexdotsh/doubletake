import { run, sleep } from './sh.ts';

// Other work on the machine, measured from outside: every process's cumulative CPU time from `ps`, once a
// second, minus doubletake's own process tree and the device's (the root process that runs it, matched by
// `isDevice`, and everything below it). A steady background is shared by both sides of a pair; a burst is not.

type Proc = { pid: number; ppid: number; cpuMs: number; command: string };
/** CPU per process, keyed by pid and command so a reused pid counts as a new process. */
export type CpuSnapshot = { at: number; byProc: Map<string, number>; names?: Map<string, string> };

/** "1:02.34", "1:02:03", "2-01:02:03" (ps time, macOS or procps) to ms. */
export function psTime(text: string): number {
  const [days, rest] = text.includes('-') ? text.trim().split('-') : ['0', text.trim()];
  const parts = (rest ?? '').split(':').map(Number);
  return Math.round((Number(days) * 86_400 + parts.reduce((total, part) => total * 60 + part, 0)) * 1000);
}

export function parsePs(out: string): Proc[] {
  return out.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), cpuMs: psTime(match[3] ?? '0'), command: match[4] ?? '' }]
      : [];
  });
}

/** Processes outside doubletake's tree and the device's root process and its descendants. */
export function others(procs: readonly Proc[], self: number, isDevice: (command: string) => boolean): Proc[] {
  const mine = new Set(procs.filter((p) => p.pid === self || isDevice(p.command)).map((p) => p.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs)
      if (!mine.has(p.pid) && mine.has(p.ppid)) {
        mine.add(p.pid);
        grew = true;
      }
  }
  return procs.filter((p) => !mine.has(p.pid));
}

export async function snapshot(isDevice: (command: string) => boolean): Promise<CpuSnapshot> {
  // `comm` (the executable's path, last so it may hold spaces) names a program; `command` adds its arguments.
  const [all, comm] = await Promise.all([
    run('ps', ['-Ao', 'pid=,ppid=,time=,command=']),
    run('ps', ['-Ao', 'pid=,comm=']),
  ]);
  const exe = new Map(
    comm.stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return match ? [[Number(match[1]), match[2] ?? '']] : [];
    }),
  );
  const mine = others(parsePs(all.stdout), process.pid, isDevice);
  return {
    at: Date.now(),
    byProc: new Map(mine.map((p) => [`${p.pid} ${p.command}`, p.cpuMs])),
    names: new Map(
      mine.map((p) => [`${p.pid} ${p.command}`, programOf(exe.get(p.pid) ?? p.command.split(' ')[0] ?? '')]),
    ),
  };
}

/**
 * Cores the other processes used between two snapshots. A process new in `b` counts whole; one that exited
 * between them is lost, so snapshots must be close together (the sampler takes one a second).
 */
export function coresBetween(a: CpuSnapshot, b: CpuSnapshot): number {
  let ms = 0;
  for (const [key, cpu] of b.byProc) ms += Math.max(0, cpu - (a.byProc.get(key) ?? 0));
  return ms / Math.max(1, b.at - a.at);
}

/**
 * Other processes' CPU over a block, in cores: the mean, the busiest 5-second stretch, and the three programs
 * that used the most (by executable name, averaged over the block).
 */
export type Others = { mean: number; busiest: number; top: { name: string; cores: number }[] };

/** The file name of an executable's path: `/a/b c/qemu-system-aarch64` gives `qemu-system-aarch64`. */
export const programOf = (path: string) => path.split('/').pop() ?? '';

/** CPU ms per program between two snapshots, added into `into`. */
export function addByProgram(a: CpuSnapshot, b: CpuSnapshot, into: Map<string, number>): void {
  for (const [key, cpu] of b.byProc) {
    const ms = Math.max(0, cpu - (a.byProc.get(key) ?? 0));
    if (!ms) continue;
    const name = b.names?.get(key) ?? programOf(key.slice(key.indexOf(' ') + 1).split(' ')[0] ?? '');
    into.set(name, (into.get(name) ?? 0) + ms);
  }
}

export function watchOthers(isDevice: (command: string) => boolean): { stop(): Promise<Others> } {
  const state: { running: boolean; error?: unknown } = { running: true };
  const intervals: { ms: number; cores: number }[] = [];
  const byProgram = new Map<string, number>();
  const loop = (async () => {
    let previous = await snapshot(isDevice);
    while (state.running) {
      await sleep(1000);
      const next = await snapshot(isDevice);
      intervals.push({ ms: next.at - previous.at, cores: coresBetween(previous, next) });
      addByProgram(previous, next, byProgram);
      previous = next;
    }
  })().catch((error: unknown) => {
    // Held until stop(), so a failed `ps` never ends the process mid-block.
    state.error = error;
  });
  return {
    async stop() {
      state.running = false;
      await loop;
      if (state.error) throw state.error;
      return summarize(intervals, byProgram);
    },
  };
}

export function summarize(
  intervals: readonly { ms: number; cores: number }[],
  byProgram: ReadonlyMap<string, number> = new Map(),
): Others {
  const ms = Math.max(
    1,
    intervals.reduce((sum, i) => sum + i.ms, 0),
  );
  const mean = intervals.reduce((sum, i) => sum + i.cores * i.ms, 0) / ms;
  const top = [...byProgram]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, cpu]) => ({ name, cores: cpu / ms }));
  return { mean, busiest: busiest(intervals, 5000), top };
}

/** The highest average over any run of consecutive intervals spanning at least `span` ms (or all of them). */
export function busiest(intervals: readonly { ms: number; cores: number }[], span: number): number {
  let best = 0;
  for (let i = 0; i < intervals.length; i++) {
    let ms = 0;
    let work = 0;
    for (let j = i; j < intervals.length && ms < span; j++) {
      const interval = intervals[j];
      if (!interval) break;
      ms += interval.ms;
      work += interval.cores * interval.ms;
    }
    if (ms >= span || i === 0) best = Math.max(best, work / Math.max(1, ms));
  }
  return best;
}
