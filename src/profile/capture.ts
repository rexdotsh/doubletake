import type { ChildProcess } from 'node:child_process';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Step } from '../bench.ts';
import { find, connect } from '../cdp.ts';
import { Refusal } from '../device.ts';
import { type FlowState, runSteps } from '../flow.ts';
import { run, sleep, stop, stream } from '../sh.ts';
import { isRecord } from '../util.ts';
import { parseCpuProfile, parseJsProfile, str } from './hermes.ts';
import type { Profile, ProfileKind } from './model.ts';
import { parseSample, parseSimpleperf } from './native.ts';
import { sourceMap, symbolicate } from './symbols.ts';

// Recorders: each starts right before a run's window (for a cold launch, before the app exists), and stops at
// its end with the raw file kept next to the experiment. Profiled runs are never timed.

export type Recorder = {
  kind: ProfileKind;
  /** `cold`: a launch case; the app is not running yet. */
  start(state: FlowState, cold: boolean): Promise<void>;
  /** A launch case, right after the app started. */
  launched(state: FlowState): Promise<void>;
  /** Ends recording; the raw output goes to `raw` plus an extension. */
  stop(state: FlowState, raw: string): Promise<Profile>;
  /** Kills whatever this recorder still has running (a failed run, a refused stop); never throws. */
  abort(): Promise<void>;
};

const quietly = (work: () => Promise<unknown>) =>
  work().then(
    () => undefined,
    () => undefined,
  );

/** An expected way for a profiler not to start: a refusal for its kind, not a failed experiment. */
const refusal = (what: string, error: unknown) =>
  error instanceof Refusal
    ? new Refusal('NoProfiler', `${what}: ${error.message}`)
    : new Refusal('NoProfiler', `${what}: ${error instanceof Error ? error.message : String(error)}`);

/** Starts `cmd`, reads the pid it prints first, and fails with its output if it exits within `settle` ms. */
async function background(cmd: string, args: string[], what: string, settle = 500) {
  const lines: string[] = [];
  const first = Promise.withResolvers<string>();
  const child = stream(cmd, args, (line) => {
    lines.push(line);
    first.resolve(line.trim());
  });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const timer = setTimeout(() => first.resolve(''), 5000);
  const pid = await first.promise;
  clearTimeout(timer);
  const early = await Promise.race([exited.then(() => true), sleep(settle).then(() => false)]);
  if (early || !/^\d+$/.test(pid)) {
    await stop(child, 'SIGKILL');
    throw new Refusal('NoProfiler', `${what} did not start: ${lines.join(' ').trim() || 'no output'}`);
  }
  return { child, pid, exited };
}

async function ended(child: ChildProcess, exited: Promise<void>, ms: number, what: string): Promise<void> {
  if (await Promise.race([exited.then(() => true), sleep(ms).then(() => false)])) return;
  await stop(child, 'SIGKILL');
  throw new Error(`${what} did not finish within ${ms / 1000} s`);
}

/**
 * Android: simpleperf's cpu-clock at 1 kHz with frame-pointer call chains, on every thread of the app. `--app`
 * waits for a cold launch's process. Needs a rooted (userdebug) device or a profileable build.
 */
export function simpleperf(serial: string, appId: string): Recorder {
  let session: Awaited<ReturnType<typeof background>> | undefined;
  const remote = `/data/local/tmp/doubletake-profile.data`;
  const shell = async (cmd: string) => (await run('adb', ['-s', serial, 'shell', cmd])).stdout;
  return {
    kind: 'native',
    async start() {
      await shell(`rm -f ${remote}`);
      session = await background(
        'adb',
        [
          '-s',
          serial,
          'shell',
          `simpleperf record --app ${appId} -e cpu-clock -f 1000 --call-graph fp -o ${remote} 2>&1 & echo $!; wait`,
        ],
        'simpleperf',
      );
    },
    launched: async () => {},
    async stop(_state, raw) {
      if (!session) throw new Error('simpleperf was not started');
      await shell(`kill -INT ${session.pid} 2>/dev/null || true`);
      // On a timeout the session stays set, so abort() kills the device's simpleperf too.
      await ended(session.child, session.exited, 30_000, 'simpleperf');
      session = undefined;
      await shell(`simpleperf report-sample --show-callchain -i ${remote} -o ${remote}.txt`);
      await run('adb', ['-s', serial, 'pull', remote, `${raw}.data`]);
      await run('adb', ['-s', serial, 'pull', `${remote}.txt`, `${raw}.txt`]);
      await shell(`rm -f ${remote} ${remote}.txt`);
      const text = await readFile(`${raw}.txt`, 'utf8');
      return parseSimpleperf(text);
    },
    async abort() {
      const live = session;
      session = undefined;
      if (!live) return;
      await quietly(() => shell(`kill -9 ${live.pid} 2>/dev/null; rm -f ${remote} ${remote}.txt`));
      await quietly(() => stop(live.child, 'SIGKILL'));
    },
  };
}

/**
 * iOS Simulator: `/usr/bin/sample` on the app's host process, every thread at 1 ms, attached by the pid the launch
 * returned (never by name: another simulator's copy of the app has the same executable). For a cold launch it
 * attaches once \`simctl launch\` has returned, so the process's first moments are not in the profile, and the
 * profile says so. Instruments' Time Profiler would be the platform's own; this is what runs everywhere.
 */
export function sampler(): Recorder {
  let session: { child: ChildProcess; exited: Promise<void>; file: string } | undefined;
  let cold = false;
  const begin = async (pid: number | undefined) => {
    if (!pid) throw new Refusal('NoProfiler', 'sample: no app process to attach to');
    const file = join(tmpdir(), `doubletake-sample-${process.pid}-${Date.now()}.txt`);
    const child = stream('/usr/bin/sample', [String(pid), '120', '1', '-mayDie', '-file', file], () => {});
    session = { child, file, exited: new Promise((resolve) => child.once('close', () => resolve())) };
    // `sample` attaches within a few ms; give it that before the window opens.
    await sleep(200);
    if (child.exitCode !== null) {
      session = undefined;
      throw new Refusal('NoProfiler', `sample could not attach to pid ${pid}`);
    }
  };
  return {
    kind: 'native',
    async start(state, isCold) {
      cold = isCold;
      if (!isCold) await begin(state.launched?.pid);
    },
    launched: (state) => begin(state.launched?.pid),
    async stop(_state, raw) {
      if (!session) throw new Error('sample was not started');
      session.child.kill('SIGINT');
      // sample symbolicates after it stops: seconds for a large app. On a timeout abort() cleans up.
      await ended(session.child, session.exited, 60_000, 'sample');
      const { file } = session;
      session = undefined;
      const text = await readFile(file, 'utf8').catch(() => '');
      await rm(file, { force: true });
      if (!text) throw new Refusal('NoProfiler', 'sample wrote no report (is the app a simulator process?)');
      await writeFile(`${raw}.txt`, text);
      const p = parseSample(text);
      return cold ? { ...p, notes: [...p.notes, 'sampling began once the launch command returned'] } : p;
    },
    async abort() {
      const live = session;
      session = undefined;
      if (!live) return;
      await quietly(() => stop(live.child, 'SIGKILL'));
      await rm(live.file, { force: true });
    },
  };
}

/**
 * JS on a dev build: Hermes's sampling profiler through Metro's inspector proxy (CDP `Profiler`), on the runtime
 * cdp.ts picks for the app and device. A cold launch is profiled from when its runtime appears on Metro, so the
 * bundle's first evaluation may be missed; the profile says how late it began.
 */
export function metroProfiler(metro: string, appId: string, device: string): Recorder {
  let session: Awaited<ReturnType<typeof connect>> | undefined;
  let late = 0;
  const begin = async () => {
    const started = Date.now();
    try {
      session = await connect(await find(metro, appId, device));
      await session.send('Profiler.enable');
      await session.send('Profiler.start');
    } catch (error) {
      session?.close();
      session = undefined;
      throw refusal('Hermes profiler over CDP', error);
    }
    late = Date.now() - started;
  };
  return {
    kind: 'js',
    async start(_state, cold) {
      if (!cold) await begin();
    },
    launched: begin,
    async stop(_state, raw) {
      if (!session) throw new Error('the CDP profiler was not started');
      const result = await session.send('Profiler.stop');
      session.close();
      session = undefined;
      const profile = isRecord(result) ? result.profile : undefined;
      await writeFile(`${raw}.cpuprofile`, JSON.stringify(profile));
      const p = await withMetroMap(parseCpuProfile(profile), profile);
      return late > 1000 ? { ...p, notes: [...p.notes, `profiling began ${late} ms after the launch`] } : p;
    },
    async abort() {
      session?.close();
      session = undefined;
    },
  };
}

/** Metro serves a bundle's source map beside it (`.bundle?…` → `.map?…`): symbolicate with that one. */
async function withMetroMap(p: Profile, raw: unknown): Promise<Profile> {
  const nodes = isRecord(raw) && Array.isArray(raw.nodes) ? raw.nodes : [];
  const url = nodes
    .map((n: unknown) => (isRecord(n) && isRecord(n.callFrame) ? str(n.callFrame.url) : ''))
    .find((u) => /^https?:\/\/.*\.bundle(\?|$)/.test(u));
  if (!url) return p;
  const response = await fetch(url.replace(/\.bundle(?=\?|$)/, '.map')).catch(() => undefined);
  if (!response?.ok) return { ...p, notes: [...p.notes, `Metro served no source map for ${url.split('?')[0]}`] };
  return symbolicate(p, sourceMap(await response.json()));
}

/** What an app offers for JS profiles on a release build: steps that start and stop its profiler, and its file. */
export type Hook = { start?: Step[]; stop: Step[]; file: string };

/**
 * JS through the app's own hook (a deep link or a test-only screen that calls Hermes's sampling profiler, for
 * example through react-native-release-profiler). `file` is where the app writes the profile: on Android an
 * absolute path or one under the app's data folder, on iOS under its data container; a path ending in `/` takes
 * the newest file in that folder.
 */
export function hookProfiler(hook: Hook, read: (path: string) => Promise<string>): Recorder {
  const begin = async (state: FlowState) => {
    if (hook.start)
      await runSteps(hook.start, state).catch((error: unknown) =>
        Promise.reject(refusal("the app's profiler hook", error)),
      );
  };
  return {
    kind: 'js',
    async start(state, cold) {
      if (!cold) await begin(state);
    },
    launched: begin,
    async stop(state, raw) {
      await runSteps(hook.stop, state);
      const text = await read(hook.file);
      await writeFile(`${raw}.json`, text);
      return parseJsProfile(JSON.parse(text));
    },
    // The app's profiler lives in the app, which every block terminates when it ends.
    abort: async () => {},
  };
}

/** Single-quoted for a POSIX shell. */
const q = (x: string) => `'${x.replaceAll("'", `'\\''`)}'`;

/**
 * The device shell command that prints an app's file, `path` ending in `/` for the newest file in that folder:
 * as the shell (root, or a world-readable path), else as the app through run-as (a debuggable build), the
 * folder listed by the same user that reads it.
 */
export function androidReadCommand(appId: string, path: string): string {
  const full = path.startsWith('/') ? path : `/data/data/${appId}/${path}`;
  const script = full.endsWith('/') ? `cd ${q(full)} && cat "$(ls -t | head -1)"` : `cat ${q(full)}`;
  return `(${script}) 2>/dev/null || run-as ${appId} sh -c ${q(script)}`;
}

/** Reads a file of the app on Android. */
export function androidReader(serial: string, appId: string) {
  return async (path: string): Promise<string> => {
    const out = await run('adb', ['-s', serial, 'exec-out', androidReadCommand(appId, path)], { check: false });
    if (!out.stdout) throw new Refusal('NoProfiler', `the app wrote no profile at ${path}`);
    return out.stdout;
  };
}

/** Reads a file of the app on the iOS Simulator, under its data container. */
export function iosReader(udid: string, appId: string) {
  return async (path: string): Promise<string> => {
    const root = (await run('xcrun', ['simctl', 'get_app_container', udid, appId, 'data'])).stdout.trim();
    let full = join(root, path);
    if (path.endsWith('/')) {
      const files = await Promise.all(
        (await readdir(full)).map(async (f) => ({ f, t: (await stat(join(full, f))).mtimeMs })),
      );
      const newest = files.toSorted((a, b) => b.t - a.t)[0];
      if (!newest) throw new Refusal('NoProfiler', `the app wrote no profile in ${path}`);
      full = join(full, newest.f);
    }
    return readFile(full, 'utf8');
  };
}
