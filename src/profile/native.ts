import { type Profile, builder } from './model.ts';

// Native profiles as text: macOS `/usr/bin/sample` (an iOS Simulator app is a Mac process) and Android
// `simpleperf report-sample`. sample sees every thread whether it runs or waits, so stacks that end in a
// blocking call are waiting, not CPU, and are left out; simpleperf's cpu-clock only samples running threads.

/** Leaf functions where a sampled macOS thread is blocked, not running. */
const WAITING = new Set([
  'mach_msg2_trap',
  'mach_msg_trap',
  '__psynch_cvwait',
  '__psynch_mutexwait',
  '__workq_kernreturn',
  'kevent',
  'kevent64',
  'kevent_id',
  '__semwait_signal',
  '__ulock_wait',
  '__ulock_wait2',
  'poll',
  '__select',
  '__sigsuspend',
  'semaphore_wait_trap',
  'semaphore_timedwait_trap',
]);

/** `Thread_123: name` or `Thread_123   DispatchQueue_1: label  (serial)` to the name or label; ids vary per run. */
function threadName(text: string): string {
  const queue = /DispatchQueue_\d+: (.+?)(?:\s+\((?:serial|concurrent)\))?$/.exec(text)?.[1];
  const named = /^Thread_\d+: (.+)$/.exec(text)?.[1];
  return queue ?? named ?? '(unnamed thread)';
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path;

/** Thread names with their numbers folded (`binder:812_3`, `pool-2-thread-1`), so runs and builds line up. */
const threadKind = (name: string) => name.replace(/\d+/g, '#');

/**
 * `simpleperf report-sample --show-callchain` text: per sample its event count (ns of cpu-clock), thread name,
 * the leaf (vaddr_in_file, file, symbol) and then its callers under `callchain:`, leaf side first.
 */
export function parseSimpleperf(text: string): Profile {
  const b = builder('native', 'simpleperf');
  let samples = 0;
  for (const block of text.split(/^sample:$/m).slice(1)) {
    const field = (name: string) => new RegExp(`^\\s*${name}: (.*)$`, 'm').exec(block)?.[1];
    const ns = Number(field('event_count'));
    const thread = threadKind(field('thread_name') ?? '?');
    const entries = [...block.matchAll(/^\s*file: (.*)\n\s*symbol: (.*)$/gm)];
    if (!Number.isFinite(ns) || !entries.length) continue;
    samples++;
    const path = entries.toReversed().map((e) => b.frame({ name: e[2] ?? '?', module: basename(e[1] ?? '?') }));
    b.add(thread, path, ns / 1e6);
  }
  if (!samples) throw new Error('no samples in the simpleperf report');
  return b.done();
}

/** A `sample` report's call graph; each sample is one interval of the thread's time (1 ms unless it says). */
export function parseSample(text: string): Profile {
  const interval = Number(/every (\d+(?:\.\d+)?) millisecond/.exec(text)?.[1] ?? 1);
  const start = text.indexOf('Call graph:');
  if (start < 0) throw new Error('not a sample report: no call graph');
  const b = builder('native', 'sample');
  const path: { frame: number; name: string; count: number; children: number }[] = [];
  let thread = '';
  let waiting = 0;
  const flush = (depth: number) => {
    // Nodes deeper than `depth` are complete: what their children did not take is their own (self) time.
    while (path.length > depth) {
      const node = path.at(-1);
      if (!node) break;
      const self = node.count - node.children;
      const frames = path.map((p) => p.frame);
      path.pop();
      if (self <= 0) continue;
      if (WAITING.has(node.name)) waiting += self * interval;
      else b.add(thread, frames, self * interval);
    }
  };
  for (const line of text.slice(start).split('\n').slice(1)) {
    if (!line.trim()) break;
    const m = /^(\s*[+!:| ]*?)(\d+) (.*)$/.exec(line);
    if (!m?.[1] || !m[2] || m[3] === undefined) continue;
    const level = (m[1].length - 4) / 2;
    if (!Number.isInteger(level) || level < 0) continue;
    const count = Number(m[2]);
    if (level === 0) {
      flush(0);
      thread = threadName(m[3].trim());
      continue;
    }
    flush(level - 1);
    const frame = /^(.*?)\s{2}\(in ([^)]+)\)/.exec(m[3]);
    const parent = path.at(-1);
    if (parent) parent.children += count;
    const name = frame?.[1] ?? m[3].trim();
    path.push({ frame: b.frame({ name, module: frame?.[2] ?? '?' }), name, count, children: 0 });
  }
  flush(0);
  return b.done(waiting ? [`${Math.round(waiting)} ms of threads waiting (blocked in the kernel) left out`] : []);
}
