import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '../src/bench.ts';
import { Refusal } from '../src/device.ts';
import { type Recorder, androidReadCommand, background, simpleperfCommand } from '../src/profile/capture.ts';
import { run } from '../src/sh.ts';
import { hooks, symbolFiles } from '../src/profile/session.ts';
import { called, diffProfiles } from '../src/profile/diff.ts';
import { flameSvg } from '../src/profile/flame.ts';
import { parseCpuProfile, parseHermesTrace, parseJsProfile, toCpuProfile } from '../src/profile/hermes.ts';
import { type Profile, type ProfileKind, builder, costs, mean } from '../src/profile/model.ts';
import { parseSample, parseSimpleperf, threadName } from '../src/profile/native.ts';
import {
  deobfuscate,
  deobfuscateProfile,
  loadR8,
  parseR8,
  r8Classes,
  sourceMap,
  symbolicate,
} from '../src/profile/symbols.ts';
import { profileCard, profileText } from '../src/profile/report.ts';
import { side } from '../src/profile/result.ts';
import type { Experiment } from '../src/store.ts';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const enc = (...fields: number[]) =>
  fields
    .map((f) => {
      let v = f < 0 ? (-f << 1) | 1 : f << 1;
      let out = '';
      do {
        let digit = v & 31;
        v >>>= 5;
        if (v) digit |= 32;
        out += B64[digit];
      } while (v);
      return out;
    })
    .join('');

const get = <T>(xs: readonly T[], f: (x: T) => boolean): T => {
  const found = xs.find(f);
  if (!found) throw new Error('not found');
  return found;
};

test('a .cpuprofile reads to stacks; idle and the gap after a sample are left out', () => {
  const p = parseCpuProfile({
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 }, children: [2, 4] },
      { id: 2, callFrame: { functionName: 'outer', url: 'b.js', lineNumber: 0, columnNumber: 10 }, children: [3] },
      { id: 3, callFrame: { functionName: 'inner', url: 'b.js', lineNumber: 0, columnNumber: 50 } },
      { id: 4, callFrame: { functionName: '(idle)', url: '', lineNumber: -1, columnNumber: -1 } },
    ],
    startTime: 0,
    // Samples 1 ms apart, then a 50 ms gap the sampler did not see the thread run in.
    samples: [3, 3, 2, 4, 3],
    timeDeltas: [0, 1000, 1000, 1000, 50000],
  });
  const c = costs(p);
  expect(get(c.functions, (f) => f.name === 'inner')).toMatchObject({ self: 3, total: 3 });
  expect(get(c.functions, (f) => f.name === 'outer')).toMatchObject({ self: 1, total: 4 });
  expect(c.ms).toBe(4);
  expect(p.notes).toEqual(['1 ms with no JS on the stack left out']);
  expect(p.frames.find((f) => f.name === 'inner')?.at).toEqual({ line: 1, column: 50 });
});

test('a Hermes sampling trace reads to the same shape, positions from the bytecode address', () => {
  const p = parseHermesTrace({
    traceEvents: [],
    stackFrames: {
      '1': { name: '[root]', category: 'root' },
      '2': { name: 'run(1:100)', category: 'JavaScript', parent: 1, funcVirtAddr: '90', offset: '10' },
      '3': { name: 'leaf(1:300)', category: 'JavaScript', parent: 2, line: '1', column: '300' },
      '4': { name: '[GC Young Gen]', category: 'Metadata', parent: 2 },
    },
    samples: [
      { ts: '1000', tid: '7', sf: 3 },
      { ts: '2000', tid: '7', sf: 3 },
      { ts: '3000', tid: '7', sf: 4 },
      { ts: '4000', tid: '7', sf: 1 },
    ],
  });
  const c = costs(p);
  expect(get(c.functions, (f) => f.name === 'leaf').self).toBe(2);
  expect(get(c.functions, (f) => f.name === 'run').total).toBe(3);
  expect(get(c.functions, (f) => f.name === '[GC Young Gen]').module).toBe('(hermes)');
  expect(p.frames.find((f) => f.name === 'run')?.at).toEqual({ line: 1, column: 100 });
  expect(p.notes).toEqual(['1 ms with no JS on the stack left out']);
  expect(costs(parseJsProfile({ stackFrames: {}, samples: [] })).ms).toBe(0);
  expect(() => parseJsProfile({ nodes: [] })).toThrow('not a .cpuprofile');
});

test('recursion counts once in total time, and the mean profile divides by the runs', () => {
  const b = builder('native', 'test');
  const f = b.frame({ name: 'f', module: 'lib' });
  const g = b.frame({ name: 'g', module: 'lib' });
  b.add('main', [f, g, f], 10);
  b.add('main', [f], 2);
  const p = b.done();
  const c = costs(p);
  expect(get(c.functions, (x) => x.name === 'f')).toMatchObject({ self: 12, total: 12 });
  expect(get(c.functions, (x) => x.name === 'g')).toMatchObject({ self: 0, total: 10 });
  expect(c.modules[0]).toMatchObject({ name: 'lib', self: 12, total: 12 });
  expect(c.threads[0]).toMatchObject({ name: 'main', total: 12 });
  const avg = mean([p, p, b.done()]);
  expect(avg && costs(avg).ms).toBe(12);
});

test('JS frames symbolicate through the source map, with names from Metro function maps', () => {
  const sources = ['/node_modules/lodash/index.js', '/app/src/screens/Home.tsx', '/app/src/hooks/useThing.ts'];
  const map = sourceMap({
    version: 3,
    sources,
    names: ['minifiedName'],
    // One generated line (as Hermes's bytecode map): col 0 → lodash 1:0, col 100 → Home 10:2, col 200 → useThing 3:0.
    mappings: [enc(0, 0, 0, 0), enc(100, 1, 9, 2), enc(100, 1, -7, -2, 0)].join(','),
    x_facebook_sources: [
      null,
      [{ names: ['<global>', 'HomeScreen'], mappings: [enc(0, 0, 0), enc(0, 1, 9)].join(',') }],
      [{ names: ['useThing'], mappings: enc(0, 0, 2) }],
    ],
  });
  expect(map.lookup(1, 150)).toEqual({ source: sources[1] ?? '', line: 10, column: 2, name: 'HomeScreen' });
  const b = builder('js', 'hermes');
  const at = (column: number, name: string) => b.frame({ name, module: '(bundle)', at: { line: 1, column } });
  b.add(undefined, [at(110, 'a'), at(205, 'b')], 4);
  b.add(undefined, [at(120, 'c'), at(50, 'd')], 2);
  b.add(undefined, [at(110, 'a'), at(9_999, 'e')], 1);
  const p = symbolicate(b.done(), map);
  const c = costs(p);
  // Two bundle positions in HomeScreen are one function.
  expect(get(c.functions, (f) => f.name === 'HomeScreen')).toMatchObject({
    module: '(app) screens',
    file: 'app/src/screens/Home.tsx',
    total: 7,
  });
  // Past the line's last segment, a position takes that segment: 9999 is in useThing too.
  expect(get(c.functions, (f) => f.name === 'useThing')).toMatchObject({ module: '(app) hooks', self: 5 });
  expect(get(c.functions, (f) => f.name === 'd')).toMatchObject({ module: 'lodash', file: 'lodash/index.js' });
  expect(get(c.modules, (m) => m.name === '(app) screens').total).toBe(7);
});

test('an indexed source map looks up inside the right section', () => {
  const map = sourceMap({
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['a.js'], names: [], mappings: enc(0, 0, 0, 0) } },
      {
        offset: { line: 5, column: 0 },
        map: { version: 3, sources: ['b.js'], names: [], mappings: `;${enc(4, 0, 6, 0)}` },
      },
    ],
  });
  expect(map.lookup(1, 3)?.source).toBe('a.js');
  expect(map.lookup(7, 9)).toEqual({ source: 'b.js', line: 7, column: 0, name: undefined });
});

test('a one-field segment ends the mapped range before it', () => {
  // AAAA maps column 0 to a.js; U (column 10) starts unmapped code; column 20 maps again.
  const map = sourceMap({ version: 3, sources: ['a.js'], names: [], mappings: `AAAA,U,${enc(10, 0, 4, 0)}` });
  expect(map.lookup(1, 5)?.source).toBe('a.js');
  expect(map.lookup(1, 15)).toBeUndefined();
  expect(map.lookup(1, 25)).toMatchObject({ source: 'a.js', line: 5 });
});

test('sections nested in a section look up through both offsets', () => {
  const inner = { version: 3, sources: ['c.js'], names: [], mappings: `;${enc(0, 0, 2, 0)}` };
  const map = sourceMap({
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['a.js'], names: [], mappings: enc(0, 0, 0, 0) } },
      {
        offset: { line: 10, column: 0 },
        map: { version: 3, sections: [{ offset: { line: 2, column: 0 }, map: inner }] },
      },
    ],
  });
  expect(map.sources).toEqual(['a.js', 'c.js']);
  expect(map.lookup(14, 3)).toMatchObject({ source: 'c.js', line: 3 });
  expect(map.lookup(12, 0)).toBeUndefined();
});

test('R8 mapping names obfuscated classes and methods back', () => {
  const r8 = parseR8(
    [
      '# compiler: R8',
      'com.example.feed.FeedAdapter -> a.b:',
      '    int count -> a',
      '    1:4:void bind(int):20:23 -> c',
      '    void bind(java.lang.String) -> c',
      '    5:5:void com.example.feed.Row.measure():9:9 -> d',
    ].join('\n'),
  );
  expect(deobfuscate(r8, 'a.b.c')).toBe('com.example.feed.FeedAdapter.bind');
  expect(deobfuscate(r8, 'a.b.d')).toBe('com.example.feed.Row.measure');
  expect(deobfuscate(r8, 'a.b.z')).toBe('com.example.feed.FeedAdapter.z');
  expect(deobfuscate(r8, 'android.os.Looper.loop')).toBe('android.os.Looper.loop');
  const b = builder('native', 'simpleperf');
  b.add('main', [b.frame({ name: 'a.b.c', module: 'base.odex' })], 3);
  const p = b.done();
  expect(deobfuscateProfile(p, r8).frames[0]?.name).toBe('com.example.feed.FeedAdapter.bind');
});

test('a large R8 mapping is streamed, keeping only the classes a profile names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'doubletake-test-'));
  try {
    const file = join(dir, 'mapping.txt');
    await writeFile(file, 'com.a.Kept -> a.b:\n    void run() -> c\ncom.a.Other -> a.z:\n    void go() -> c\n');
    const b = builder('native', 'simpleperf');
    b.add('main', [b.frame({ name: 'a.b.c', module: 'base.odex' })], 1);
    const r8 = await loadR8(file, r8Classes([b.done()]));
    expect([...r8.keys()]).toEqual(['a.b']);
    expect(deobfuscate(r8, 'a.b.c')).toBe('com.a.Kept.run');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const SAMPLE = `Analysis of sampling App (pid 42) every 1 millisecond
Process:         App [42]

Call graph:
    30 Thread_100   DispatchQueue_1: com.apple.main-thread  (serial)
    + 30 start  (in dyld) + 7184  [0x18b519d54]
    +   20 main  (in App) + 64  [0x100]
    +   ! 12 layout  (in UIKitCore) + 8  [0x200]
    +   ! 3 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x300]
    +   10 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x300]
    25 Thread_101: com.facebook.react.JavaScript
    + 25 thread_start  (in libsystem_pthread.dylib) + 8  [0x400]
    +   25 hermes::vm::Interpreter::run  (in hermes) + 4  [0x500]
    7 Thread_102
    + 7 thread_start  (in libsystem_pthread.dylib) + 8  [0x400]
    +   7 __workq_kernreturn  (in libsystem_kernel.dylib) + 8  [0x600]

Total number in stack (recursive counted multiple, when >=5):
`;

test('sample reports: self time per frame, threads by name, waiting left out', () => {
  const p = parseSample(SAMPLE);
  const c = costs(p);
  expect(c.ms).toBe(42);
  expect(get(c.functions, (f) => f.name === 'main')).toMatchObject({ module: 'App', self: 5, total: 17 });
  expect(get(c.functions, (f) => f.name === 'layout').self).toBe(12);
  expect(c.threads.map((t) => [t.name, t.total])).toEqual([
    ['com.facebook.react.JavaScript', 25],
    ['com.apple.main-thread', 17],
  ]);
  expect(p.notes).toEqual(['20 ms of threads waiting (blocked in the kernel) left out']);
});

const SIMPLEPERF = `meta_info:
  event_type: cpu-clock
sample:
  event_type: cpu-clock
  time: 1
  event_count: 1000000
  thread_id: 20829
  thread_name: mqt_v_js
  vaddr_in_file: 10
  file: /data/app/x/base.apk!/lib/arm64-v8a/libhermesvm.so
  symbol: hermes::vm::Interpreter::interpretFunction
  callchain:
    vaddr_in_file: 20
    file: /apex/com.android.runtime/lib64/bionic/libc.so
    symbol: __start_thread
sample:
  event_type: cpu-clock
  time: 2
  event_count: 2000000
  thread_id: 20830
  thread_name: binder:20829_3
  vaddr_in_file: 30
  file: [kernel.kallsyms]
  symbol: binder_ioctl
`;

test('simpleperf report-sample: leaf first, callers below, ns of cpu-clock, thread numbers folded', () => {
  const p = parseSimpleperf(SIMPLEPERF);
  const c = costs(p);
  expect(c.ms).toBe(3);
  expect(get(c.functions, (f) => f.name === 'hermes::vm::Interpreter::interpretFunction')).toMatchObject({
    module: 'libhermesvm.so',
    self: 1,
  });
  expect(get(c.functions, (f) => f.name === '__start_thread')).toMatchObject({ self: 0, total: 1 });
  expect(c.threads.map((t) => t.name)).toEqual(['binder:#_#', 'mqt_v_js']);
  expect(() => parseSimpleperf('meta_info:\n')).toThrow('no samples');
});

function pairProfile(extra: number, noise: number): Profile {
  const b = builder('native', 'simpleperf');
  const main = b.frame({ name: 'main', module: 'app' });
  b.add('main', [main, b.frame({ name: 'steady', module: 'lib' })], 100 + noise);
  b.add('main', [main, b.frame({ name: 'grows', module: 'lib' })], 40 + extra);
  b.add('main', [main, b.frame({ name: 'jitter', module: 'lib' })], 30 + noise * 8);
  return b.done();
}

test('the profile diff calls only consistent, large enough changes', () => {
  const noise = [1, -2, 0, 2, -1, 1, -1, 0];
  const pairs = noise.map((n, i): [Profile, Profile] => [pairProfile(0, n), pairProfile(25, noise[7 - i] ?? 0)]);
  const d = diffProfiles(pairs);
  const grows = get(d.functions, (r) => r.name === 'grows');
  expect(grows.self).toMatchObject({ base: 40, head: 65, call: 'slower', up: 8, n: 8 });
  expect(get(d.functions, (r) => r.name === 'jitter').self.call).toBeUndefined();
  expect(get(d.functions, (r) => r.name === 'steady').self.call).toBeUndefined();
  expect(called(d, 'functions').map((r) => r.name)).toEqual(['main', 'grows']);
  // The same change seen in only 4 pairs is never called.
  expect(diffProfiles(pairs.slice(0, 4)).functions.every((r) => !r.self.call && !r.total.call)).toBe(true);
});

test("a native side's total list leaves out thread entries and kernel frames", () => {
  const b = builder('native', 'simpleperf');
  const start = b.frame({ name: '__start_thread', module: 'libc.so' });
  const work = b.frame({ name: 'work', module: 'libapp.so' });
  const sys = b.frame({ name: 'el0_svc', module: '[kernel.kallsyms]' });
  b.add('worker', [start, work], 6);
  b.add('worker', [start, work, sys], 4);
  b.add('main', [b.frame({ name: 'loop', module: 'libapp.so' })], 1);
  const s = side(b.done(), { role: 'head', label: 'x', runs: 1, flame: '' });
  expect(s.total.map((c) => c.name)).toEqual(['work', 'loop']);
  expect(s.threadTop?.[0]).toMatchObject({ thread: 'worker' });
  expect(s.threadTop?.[0]?.self.map((c) => c.name)).toEqual(['work', 'el0_svc', '__start_thread']);
});

test('a flame graph is one self-contained SVG with escaped names', () => {
  const b = builder('native', 'sample');
  b.add('main', [b.frame({ name: 'std::vector<int>::push', module: 'App' })], 5);
  const svg = flameSvg(b.done(), 'cold start & more');
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(svg).toContain('std::vector&lt;int&gt;::push');
  expect(svg).toContain('cold start &amp; more');
  expect(svg.match(/https?:\/\//g)).toEqual(['http://']);
});

test('a profile written as .cpuprofile reads back to the same costs', () => {
  const p = parseSample(SAMPLE);
  const back = costs(parseCpuProfile(toCpuProfile(p)));
  const before = costs(p);
  expect(back.ms).toBeCloseTo(before.ms, 1);
  expect(get(back.functions, (f) => f.name === 'layout').self).toBeCloseTo(12, 1);
});

test('a bench file may declare an app profiler hook, and is checked', () => {
  const bench = validate({
    cases: { idle: { idle: '5s', primary: 'cpu.idle' } },
    profile: { js: { stop: [{ open: 'app://profile/stop' }], file: { android: 'cache/profiles/' } } },
  });
  expect(bench.profile?.js?.file.android).toBe('cache/profiles/');
  expect(() => validate({ cases: bench.cases, profile: { js: { stop: [], file: { web: 'x' } } } })).toThrow(
    'unknown key web',
  );
});

test('the report and the card show the profile and what moved', () => {
  const noise = [1, -2, 0, 2, -1, 1];
  const pairs = noise.map((n): [Profile, Profile] => [pairProfile(0, n), pairProfile(25, -n)]);
  const e: Experiment = {
    schema: 'doubletake.experiment.v1',
    id: 'exp_p',
    kind: 'experiment',
    created: '2026-01-01T00:00:00Z',
    file: 'app.bench.ts',
    comparison: 'builds',
    device: { platform: 'android', name: 'emulator', os: '16', id: 'emulator-5554', host: '' },
    variants: [],
    plan: { pairs: 8, runs: 1, warmup_runs: 1, warmup_blocks: 1, order: 'ABBA', install: 'sequential' },
    decided: true,
    series: [],
    checks: [],
    warnings: [],
    profiles: [
      {
        case: 'cold start',
        kind: 'native',
        profiler: 'simpleperf',
        sides: [side(pairProfile(0, 0), { role: 'head', label: 'after', runs: 6, flame: 'profiles/x.svg' })],
        diff: diffProfiles(pairs),
        notes: [],
      },
    ],
    profile_refusals: [{ case: 'cold start', kind: 'js', reason: 'no hook' }],
  };
  const text = profileText(e).join('\n');
  expect(text).toContain('cold start  profile: native (simpleperf), 6 profiled pairs, never timed');
  expect(text).toContain('grows  (lib)');
  expect(text).toContain('cold start  profile (JS): not recorded: no hook');
  const card = profileCard(e).join('\n');
  expect(card).toContain('| 🔺 total | grows  (lib) | 40.0 ms | 65.0 ms | +25.0 ms (6/6) |');
});

test('sample thread lines name the thread, its queue, or neither', () => {
  expect(threadName('Thread_10215433: Main Thread   DispatchQueue_<multiple>')).toBe('Main Thread');
  expect(threadName('Thread_100   DispatchQueue_1: com.apple.main-thread  (serial)')).toBe('com.apple.main-thread');
  expect(threadName('Thread_101: com.facebook.react.JavaScript')).toBe('com.facebook.react.JavaScript');
  expect(threadName('Thread_102')).toBe('(unnamed thread)');
});

const recorder = (kind: ProfileKind, log: string[], fail?: { at: 'start' | 'stop'; error: Error }): Recorder => ({
  kind,
  start: async () => {
    log.push(`${kind} start`);
    if (fail?.at === 'start') throw fail.error;
  },
  launched: async () => {},
  stop: async () => {
    log.push(`${kind} stop`);
    if (fail?.at === 'stop') throw fail.error;
    return builder(kind, 'test').done();
  },
  abort: async () => void log.push(`${kind} abort`),
});
// The recorders here never read the flow state.
const state: Parameters<Recorder['start']>[0] = JSON.parse('{}');

test('a profiler that refuses to start is aborted, refused and dropped; the others go on', async () => {
  const log: string[] = [];
  const live = [recorder('native', log), recorder('js', log, { at: 'start', error: new Refusal('NoProfiler', 'no') })];
  const refused = new Map<ProfileKind, string>();
  const got = new Map<ProfileKind, Profile>();
  const h = hooks(live, refused, (k) => k, got);
  await h.start(state, false);
  await h.stop(state);
  expect(log).toEqual(['native start', 'js start', 'js abort', 'native stop']);
  expect(refused.get('js')).toBe('no');
  expect([...got.keys()]).toEqual(['native']);
});

test('an unexpected profiler failure, or a failed run, aborts every profiler, dropped ones too', async () => {
  const log: string[] = [];
  const live = [recorder('native', log), recorder('js', log, { at: 'stop', error: new Error('socket closed') })];
  const h = hooks(live, new Map(), (k) => k, new Map());
  await h.start(state, false);
  expect(
    await h.stop(state).then(
      () => 'stopped',
      (error: unknown) => String(error),
    ),
  ).toContain('socket closed');
  expect(log.filter((l) => l.endsWith('abort')).toSorted()).toEqual(['js abort', 'js abort', 'native abort']);
  const log2: string[] = [];
  const h2 = hooks([recorder('native', log2)], new Map(), (k) => k, new Map());
  await h2.start(state, true);
  await h2.abort();
  expect(log2).toEqual(['native start', 'native abort']);
});

test("an app's profile file is listed and read by the same user, the shell or the app through run-as", () => {
  expect(androidReadCommand('com.example', 'cache/profiles/')).toBe(
    `(cd '/data/data/com.example/cache/profiles/' && cat "$(ls -t | head -1)") 2>/dev/null || run-as com.example sh -c 'cd '\\''/data/data/com.example/cache/profiles/'\\'' && cat "$(ls -t | head -1)"'`,
  );
  expect(androidReadCommand('com.example', '/sdcard/p.json')).toBe(
    `(cat '/sdcard/p.json') 2>/dev/null || run-as com.example sh -c 'cat '\\''/sdcard/p.json'\\'''`,
  );
});

test('symbol files are found beside a build, or taken as given', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'doubletake-test-'));
  try {
    await writeFile(join(dir, 'app.apk'), '');
    await writeFile(join(dir, 'app.map'), '{}');
    await writeFile(join(dir, 'app.mapping.txt'), '');
    expect(await symbolFiles(join(dir, 'app.apk'))).toEqual({
      map: join(dir, 'app.map'),
      r8: join(dir, 'app.mapping.txt'),
    });
    expect(await symbolFiles(join(dir, 'other.apk'), join(dir, 'app.map'))).toEqual({
      map: join(dir, 'app.map'),
      r8: undefined,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("simpleperf's start prints only its pid, and cleanup kills it only while the pid is still that session's", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'doubletake-test-'));
  const others: ReturnType<typeof spawn>[] = [];
  try {
    // A simpleperf that complains on both streams, then keeps running (as a shell, so its command line keeps the
    // session's data path).
    await writeFile(join(dir, 'simpleperf'), '#!/bin/sh\necho "diagnostic"\necho "warning" >&2\nsleep 5\n', {
      mode: 0o755,
    });
    const env = `PATH=${dir}:$PATH; `;
    const cmd = simpleperfCommand('com.example', dir, 'a');
    const started = await background('sh', ['-c', env + cmd.start], 'simpleperf', 200);
    const pid = Number(started.pid);
    expect(Number((await readFile(cmd.files.pid, 'utf8')).trim())).toBe(pid);
    expect(await readFile(cmd.files.log, 'utf8')).toContain('diagnostic');
    await new Promise<void>((resolve) => {
      started.child.once('close', () => resolve());
      started.child.kill('SIGKILL');
    });
    // The host side is gone; the device side is still found through the pid file, and its files go.
    expect(alive(pid)).toBe(true);
    await run('sh', ['-c', cmd.kill]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(pid)).toBe(false);
    expect(await readFile(cmd.files.pid, 'utf8').catch(() => 'gone')).toBe('gone');
    // A stale pid file whose pid now belongs to another process: cleanup leaves that process alone.
    const other = spawn('sleep', ['30']);
    others.push(other);
    const stale = simpleperfCommand('com.example', dir, 'b');
    await writeFile(stale.files.pid, `${other.pid}\n`);
    await run('sh', ['-c', stale.kill]);
    expect(alive(other.pid ?? 0)).toBe(true);
    expect(await readFile(stale.files.pid, 'utf8').catch(() => 'gone')).toBe('gone');
    // A simpleperf that exits at once is refused.
    await writeFile(join(dir, 'simpleperf'), '#!/bin/sh\necho "no permission"\nexit 1\n', { mode: 0o755 });
    const refused = simpleperfCommand('com.example', dir, 'c');
    expect(
      await background('sh', ['-c', env + refused.start], 'simpleperf', 200).then(
        () => 'started',
        (error: unknown) => String(error),
      ),
    ).toContain('did not start');
  } finally {
    for (const o of others) o.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
