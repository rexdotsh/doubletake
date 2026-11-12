import { run } from './sh.ts';

// Other work on the machine, measured from outside: every process's cumulative CPU time, minus doubletake's
// own process tree and the device's (its simulator or emulator, matched by `markers` in a process's command
// line, and everything below it). A steady background is shared by both sides of a pair; a burst is not.

type Proc = { pid: number; ppid: number; cpuMs: number; command: string };
export type CpuSnapshot = { at: number; byPid: Map<number, number> };

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

/** Processes outside doubletake's tree and the device's (and their descendants). */
export function others(procs: readonly Proc[], self: number, markers: readonly string[]): Proc[] {
  const mine = new Set(
    procs.filter((p) => p.pid === self || markers.some((m) => p.command.includes(m))).map((p) => p.pid),
  );
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

export async function snapshot(markers: readonly string[]): Promise<CpuSnapshot> {
  const procs = parsePs((await run('ps', ['-Ao', 'pid=,ppid=,time=,command='])).stdout);
  return { at: Date.now(), byPid: new Map(others(procs, process.pid, markers).map((p) => [p.pid, p.cpuMs])) };
}

/** Cores the other processes used on average between two snapshots (a process new in `b` counts whole). */
export function coresBetween(a: CpuSnapshot, b: CpuSnapshot): number {
  let ms = 0;
  for (const [pid, cpu] of b.byPid) ms += Math.max(0, cpu - (a.byPid.get(pid) ?? 0));
  return ms / Math.max(1, b.at - a.at);
}
