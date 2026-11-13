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
};

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
  if (early || !/^\d+$/.test(pid))
    throw new Refusal('NoProfiler', `${what} did not start: ${lines.join(' ').trim() || 'no output'}`);
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
      await ended(session.child, session.exited, 30_000, 'simpleperf');
      session = undefined;
      await shell(`simpleperf report-sample --show-callchain -i ${remote} -o ${remote}.txt`);
      await run('adb', ['-s', serial, 'pull', remote, `${raw}.data`]);
      await run('adb', ['-s', serial, 'pull', `${remote}.txt`, `${raw}.txt`]);
      await shell(`rm -f ${remote} ${remote}.txt`);
      const text = await readFile(`${raw}.txt`, 'utf8');
      return parseSimpleperf(text);
    },
  };
}

/**
 * iOS Simulator: `/usr/bin/sample` on the app's host process, every thread at 1 ms. A cold launch waits for the
 * process by executable name. Instruments' Time Profiler would be the platform's own; this is what runs
 * everywhere `sample` does.
 */
export function sampler(executable: string | undefined): Recorder {
  let session: { child: ChildProcess; exited: Promise<void> } | undefined;
  let file = '';
  const begin = (target: string, wait: boolean) => {
    file = join(tmpdir(), `doubletake-sample-${process.pid}-${Date.now()}.txt`);
    const child = stream(
      '/usr/bin/sample',
      [target, '120', '1', ...(wait ? ['-wait'] : []), '-mayDie', '-file', file],
      () => {},
    );
    session = { child, exited: new Promise((resolve) => child.once('close', () => resolve())) };
  };
  return {
    kind: 'native',
    async start(state, cold) {
      if (!cold) begin(String(state.launched?.pid ?? 0), false);
      else if (executable) begin(executable, true);
      // `sample` attaches within a few ms; give it that before the window opens.
      await sleep(200);
    },
    async launched(state) {
      if (!session) begin(String(state.launched?.pid ?? 0), false);
    },
    async stop(_state, raw) {
      if (!session) throw new Error('sample was not started');
      session.child.kill('SIGINT');
      // sample symbolicates after it stops: seconds for a large app.
      await ended(session.child, session.exited, 60_000, 'sample');
      session = undefined;
      const text = await readFile(file, 'utf8').catch(() => '');
      if (!text) throw new Refusal('NoProfiler', 'sample wrote no report (is the app a simulator process?)');
      await writeFile(`${raw}.txt`, text);
      await rm(file, { force: true });
      return parseSample(text);
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
    session = await connect(await find(metro, appId, device));
    await session.send('Profiler.enable');
    await session.send('Profiler.start');
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
  return {
    kind: 'js',
    async start(state, cold) {
      if (!cold && hook.start) await runSteps(hook.start, state);
    },
    async launched(state) {
      if (hook.start) await runSteps(hook.start, state);
    },
    async stop(state, raw) {
      await runSteps(hook.stop, state);
      const text = await read(hook.file);
      await writeFile(`${raw}.json`, text);
      return parseJsProfile(JSON.parse(text));
    },
  };
}

/** Reads a file of the app on Android: as root, else through run-as (a debuggable build). */
export function androidReader(serial: string, appId: string) {
  return async (path: string): Promise<string> => {
    const full = path.startsWith('/') ? path : `/data/data/${appId}/${path}`;
    const pick = full.endsWith('/') ? `"${full}$(ls -t ${full} | head -1)"` : `"${full}"`;
    const out = await run('adb', ['-s', serial, 'exec-out', `cat ${pick} 2>/dev/null || run-as ${appId} cat ${pick}`]);
    if (!out.stdout) throw new Refusal('NoProfiler', `the app wrote no profile at ${full}`);
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
