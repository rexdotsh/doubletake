import { run, sleep } from './sh.ts';

// Other work on the machine, measured from outside: every process's cumulative CPU time from `ps`, once a
// second, minus doubletake's own process tree and the device's (the root process that runs it, matched by
// `isDevice`, and everything below it). A steady background is shared by both sides of a pair; a burst is not.

type Proc = { pid: number; ppid: number; cpuMs: number; command: string };
/** CPU per process, keyed by pid and command so a reused pid counts as a new process. */
export type CpuSnapshot = { at: number; byProc: Map<string, number> };

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
  const procs = parsePs((await run('ps', ['-Ao', 'pid=,ppid=,time=,command='])).stdout);
  return {
    at: Date.now(),
    byProc: new Map(others(procs, process.pid, isDevice).map((p) => [`${p.pid} ${p.command}`, p.cpuMs])),
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

/** Watches other work once a second; `stop` gives the busiest 5-second stretch, in cores. */
export function watchOthers(isDevice: (command: string) => boolean): { stop(): Promise<number> } {
  const state: { running: boolean; error?: unknown } = { running: true };
  const intervals: { ms: number; cores: number }[] = [];
  const loop = (async () => {
    let previous = await snapshot(isDevice);
    while (state.running) {
      await sleep(1000);
      const next = await snapshot(isDevice);
      intervals.push({ ms: next.at - previous.at, cores: coresBetween(previous, next) });
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
      return busiest(intervals, 5000);
    },
  };
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
