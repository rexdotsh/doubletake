import type { ProfileDiff } from './diff.ts';
import { type Cost, type Profile, type ProfileKind, costs } from './model.ts';

/** One side's profile of a case: the mean over its profiled runs, its top lists and its flame graph. */
export type ProfileSide = {
  role: 'base' | 'head';
  label: string;
  runs: number;
  /** Mean sampled time per run, ms. */
  ms: number;
  /** Top functions by self time, by total time, top modules and threads (native). */
  self: Cost[];
  total: Cost[];
  modules: Cost[];
  threads: Cost[];
  /** Native: each busy thread's top functions by self time. */
  threadTop?: { thread: string; self: Cost[] }[];
  /** The flame graph, relative to the experiment folder. */
  flame: string;
};

export type ProfileResult = {
  case: string;
  kind: ProfileKind;
  /** What recorded it: `hermes`, `simpleperf`, `sample`; reports say it. */
  profiler: string;
  sides: ProfileSide[];
  /** Base against head over the profiled pairs (bench only). */
  diff?: ProfileDiff;
  notes: string[];
};

/** A kind (or, without one, every kind) that could not be recorded for a case, and why. */
export type ProfileRefusal = { case: string; kind?: ProfileKind; reason: string };

const TOP = 15;

/** Kernel frames sit under whichever call entered the kernel; their totals say nothing about the app. */
const KERNEL = /^\[kernel/;
/** A function on nearly every stack of a thread, with little time of its own, is its entry (thread start, event
 * loop): no use as a total. */
const ENTRY_SHARE = 0.9;

export function side(p: Profile, s: Pick<ProfileSide, 'role' | 'label' | 'runs' | 'flame'>): ProfileSide {
  const c = costs(p);
  const out: ProfileSide = {
    ...s,
    ms: c.ms,
    self: c.functions.toSorted((a, b) => b.self - a.self).slice(0, TOP),
    total: c.functions.slice(0, TOP),
    modules: c.modules.slice(0, 10),
    threads: c.threads.slice(0, 8),
  };
  if (!c.threads.length) return out;
  const entries = new Set<string>();
  out.threadTop = [];
  for (const t of c.threads) {
    const own = costs({ ...p, stacks: p.stacks.filter((x) => x.thread === t.name) });
    for (const f of own.functions)
      if (f.total >= ENTRY_SHARE * own.ms && f.self < (1 - ENTRY_SHARE) * f.total) entries.add(f.key);
    if (out.threadTop.length < 5)
      out.threadTop.push({ thread: t.name, self: own.functions.toSorted((a, b) => b.self - a.self).slice(0, 5) });
  }
  out.total = c.functions.filter((f) => !entries.has(f.key) && !KERNEL.test(f.module)).slice(0, TOP);
  return out;
}
