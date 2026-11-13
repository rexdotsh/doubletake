import { get } from '../util.ts';

// A sampled CPU profile, whatever recorded it: Hermes (JS) or simpleperf / sample (native). Every format is read
// into this one shape, so symbolication, the top lists, the flame graph and the A/B diff are written once.

/** One function: a JS function after symbolication, or a native symbol. */
export type Frame = {
  name: string;
  /** JS: the npm package or app folder; native: the library or binary. */
  module: string;
  /** JS: the original source file and line, once symbolicated. */
  file?: string;
  line?: number;
  /** JS before symbolication: where the frame is in the bundle (1-based line, 0-based column). */
  at?: { line: number; column: number };
};

export type ProfileKind = 'js' | 'native';

export type Stack = { thread?: string; frames: number[]; ms: number };

export type Profile = {
  kind: ProfileKind;
  /** What recorded it, as reports name it: `hermes`, `simpleperf`, `sample`. */
  profiler: string;
  frames: Frame[];
  /** Root first. Time on a thread that was waiting is not in any stack. */
  stacks: Stack[];
  /** What a reader must know: time left out, a late start, a missing map. */
  notes: string[];
};

export type Cost = { key: string; name: string; module: string; file?: string; self: number; total: number };

export type Costs = { ms: number; functions: Cost[]; modules: Cost[]; threads: Cost[] };

/** A function's identity across builds: its name and where it lives, never a line (lines move between builds). */
export const frameKey = (f: Frame) => `${f.name}\u0000${f.module}\u0000${f.file ?? ''}`;

/** Collects frames and stacks, merging identical ones. */
export function builder(kind: ProfileKind, profiler: string) {
  const frames: Frame[] = [];
  const index = new Map<string, number>();
  const stacks = new Map<string, Stack>();
  return {
    frame(f: Frame): number {
      const key = f.at ? `${frameKey(f)}\u0000${f.at.line}:${f.at.column}` : frameKey(f);
      let i = index.get(key);
      if (i === undefined) {
        i = frames.push(f) - 1;
        index.set(key, i);
      }
      return i;
    },
    add(thread: string | undefined, path: number[], ms: number): void {
      if (ms <= 0) return;
      const key = `${thread ?? ''}\u0000${path.join(',')}`;
      const known = stacks.get(key);
      if (known) known.ms += ms;
      else stacks.set(key, { thread, frames: path, ms });
    },
    done(notes: string[] = []): Profile {
      return { kind, profiler, frames, stacks: [...stacks.values()], notes };
    },
  };
}

/** The same profile with every frame replaced: frames that become equal merge. */
export function mapFrames(p: Profile, map: (f: Frame) => Frame, notes: string[] = []): Profile {
  const b = builder(p.kind, p.profiler);
  const moved = p.frames.map((f) => b.frame(map(f)));
  for (const s of p.stacks)
    b.add(
      s.thread,
      s.frames.map((i) => get(moved, i)),
      s.ms,
    );
  return b.done([...p.notes, ...notes]);
}

/** Several profiles of one side as one, each stack's time divided by their number: the mean profile. */
export function mean(profiles: readonly Profile[]): Profile | undefined {
  const [first] = profiles;
  if (!first) return undefined;
  const b = builder(first.kind, first.profiler);
  for (const p of profiles) {
    const moved = p.frames.map((f) => b.frame(f));
    for (const s of p.stacks)
      b.add(
        s.thread,
        s.frames.map((i) => get(moved, i)),
        s.ms / profiles.length,
      );
  }
  return b.done([...new Set(profiles.flatMap((p) => p.notes))]);
}

function tally(map: Map<string, Cost>, key: string, base: Omit<Cost, 'self' | 'total'>, self: number, total: number) {
  const c = map.get(key) ?? { ...base, self: 0, total: 0 };
  c.self += self;
  c.total += total;
  map.set(key, c);
}

const sorted = (map: Map<string, Cost>) => [...map.values()].toSorted((a, b) => b.total - a.total || b.self - a.self);

/**
 * Self time is the leaf's; total time counts a stack once for every function (and module) in it, however often
 * it recurses. Threads are only in native profiles.
 */
export function costs(p: Profile): Costs {
  const functions = new Map<string, Cost>();
  const modules = new Map<string, Cost>();
  const threads = new Map<string, Cost>();
  let ms = 0;
  for (const s of p.stacks) {
    ms += s.ms;
    if (s.thread !== undefined) tally(threads, s.thread, { key: s.thread, name: s.thread, module: '' }, 0, s.ms);
    const seenF = new Set<string>();
    const seenM = new Set<string>();
    for (const [j, i] of s.frames.entries()) {
      const f = p.frames[i];
      if (!f) continue;
      const key = frameKey(f);
      const self = j === s.frames.length - 1 ? s.ms : 0;
      if (!seenF.has(key) || self)
        tally(functions, key, { key, name: f.name, module: f.module, file: f.file }, self, seenF.has(key) ? 0 : s.ms);
      seenF.add(key);
      if (!seenM.has(f.module) || self)
        tally(
          modules,
          f.module,
          { key: f.module, name: f.module, module: f.module },
          self,
          seenM.has(f.module) ? 0 : s.ms,
        );
      seenM.add(f.module);
    }
  }
  return { ms, functions: sorted(functions), modules: sorted(modules), threads: sorted(threads) };
}

/**
 * Per-sample weights from sample times (µs), each capped at the sampling interval (the median gap): a gap
 * longer than that is time the sampler did not see the thread run, not time in the last stack.
 */
export function weights(times: readonly number[]): number[] {
  const gaps = times.slice(1).map((t, i) => t - (times[i] ?? t));
  const interval = gaps.toSorted((a, b) => a - b)[gaps.length >> 1] ?? 1000;
  return times.map((_, i) => Math.min(gaps[i] ?? interval, interval) / 1000);
}
