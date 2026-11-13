import type { Bench, Case } from './bench.ts';
import { caseKind, ms } from './bench.ts';
import type { Device, LogTap, Recording } from './device.ts';
import { Refusal } from './device.ts';
import { countersIn, marksIn, ofProcess } from './events.ts';
import { type FlowState, launch, runSteps } from './flow.ts';
import { sleep } from './sh.ts';
import { type Region, VIDEO_FPS, decodeFrames, visualTimes } from './visual.ts';

type RunValues = Record<string, number>;
/** A run's recording, if filmed, and when its action began (host clock). */
type Filmed = { recording?: Recording; action: number };
/** A measured window and the start of the app process in it, device clock. */
type Window = { from: number; to: number; launched: number; pid: number };
export type RunResult = {
  values: RunValues;
  /** Metrics the run could not give, with the reason. */
  refused: Record<string, string>;
  video?: { file: string; first: number; seconds: number };
};

export type RunContext = {
  device: Device;
  appId: string;
  bench: Bench;
  case: Case;
  tap: LogTap;
  offset: number;
  dir: string;
  /** Where this run's video goes, when the run is filmed. */
  video?: string;
};

/** Log lines reach the host a few ms after they are written; wait this long after a window before reading it. */
const DRAIN_MS = 300;
const FRAME_METRICS = ['js.frames.dropped', 'js.stall'];
const NETWORK_METRICS = ['net.requests', 'net.bytes'];
const UI_FRAME_METRICS = ['frames.total', 'frames.janky', 'frames.janky.pct', 'frames.p90'];

/** A visual primary needs a recording of every run; so does a run asked to be filmed. */
export function filmed(c: Case): boolean {
  return c.primary === 'launch.visual' || (c.metrics ?? []).includes('launch.visual') || c.launch?.visual === true;
}

function refuse(refused: Record<string, string>, metrics: readonly string[], why: string): void {
  for (const m of metrics) refused[m] = why;
}

/** SDK counters for a window; families the app did not turn on are refused, never zero. */
function addSdk(values: RunValues, refused: Record<string, string>, ctx: RunContext, window: Window): void {
  const events = ofProcess(ctx.tap.events, window.pid);
  for (const [name, at] of marksIn(events, window.from, window.to)) values[`mark.${name}`] = at - window.from;
  const got = countersIn(events, window.from, window.to, window.launched);
  if (!got) {
    refuse(
      refused,
      [...FRAME_METRICS, ...NETWORK_METRICS, 'react.commits', 'react.render'],
      'NoSdk: the app wrote no doubletake start line (call start() from the SDK)',
    );
    return;
  }
  const { counters } = got;
  if (got.frames) {
    values['js.frames.dropped'] = counters.dropped;
    values['js.stall'] = counters.stall;
  } else refuse(refused, FRAME_METRICS, 'NoSdk: the app started the SDK with frames off');
  if (got.network) {
    values['net.requests'] = counters.requests;
    values['net.bytes'] = counters.bytes;
  } else refuse(refused, NETWORK_METRICS, 'NoSdk: the app started the SDK with network off');
  if (counters.commits > 0) {
    values['react.commits'] = counters.commits;
    values['react.render'] = counters.render;
  } else
    refuse(
      refused,
      ['react.commits', 'react.render'],
      'NoProfiler: no React Profiler commits (a release build, or no onRender)',
    );
}

async function addMemory(values: RunValues, ctx: RunContext, pid: number): Promise<void> {
  const memory = await ctx.device.memory(pid, ctx.appId);
  if (memory.peakMiB !== undefined) values['memory.peak'] = memory.peakMiB;
  if (memory.endMiB !== undefined) values['memory.end'] = memory.endMiB;
}

/** Stops a recording; a launch's video also gives launch.visual. Returns the clip and where its action starts. */
async function analyseVideo(
  recording: Recording,
  values: RunValues,
  refused: Record<string, string>,
  bench: Bench,
  launchCase: boolean,
  action: number,
): Promise<RunResult['video']> {
  const file = await recording.stop();
  const frames = await decodeFrames(file);
  const seconds = frames.length / VIDEO_FPS;
  if (recording.startedAt === undefined) {
    // No exact clock for the video's first frame (Android's screenrecord): time from the first change, once the
    // recorder's approximate start shows that change is the launch's (clockless).
    const launchAt = recording.startedNear === undefined ? undefined : action - recording.startedNear;
    const { first, visual, refusal } = clockless(frames, bench.ignore, launchCase, launchAt);
    if (launchCase && visual !== undefined) values['launch.visual'] = visual;
    if (launchCase && refusal) refused['launch.visual'] = refusal;
    return { file, first, seconds };
  }
  const at = Math.max(0, action - recording.startedAt);
  try {
    const visual = visualTimes(frames, bench.ignore, 1000, at);
    if (launchCase) values['launch.visual'] = visual.complete - at;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    if (launchCase) refused['launch.visual'] = `${error.validator}: ${error.message}`;
  }
  return { file, first: at / 1000, seconds };
}

/** How much earlier than the recorder's start says a launch's first change may show: its encoder start-up. */
const RECORDER_SLACK_MS = 300;

/**
 * `launch.visual` from a clip without an exact start clock: from the first change (the launch's first visible
 * response) to the frame after which the screen settles. `launchAt` (ms into the clip, from the recorder's
 * approximate start) is where the launch was issued: a change more than the recorder's start-up before it is
 * something else (an animated launcher, a widget), and the metric is refused rather than timed from it.
 * `first` is where the clip's action starts, in seconds.
 */
export function clockless(
  frames: readonly Uint8Array[],
  ignore: readonly Region[] = [],
  launchCase = true,
  launchAt?: number,
): { first: number; visual?: number; refusal?: string } {
  try {
    const visual = visualTimes(frames, ignore, launchCase ? 1000 : 0);
    if (!launchCase) return { first: visual.first / 1000 };
    if (launchAt === undefined)
      return {
        first: visual.first / 1000,
        refusal: 'NoVideoClock: this recorder gives no start time to align the launch with',
      };
    if (visual.first < launchAt - RECORDER_SLACK_MS)
      return {
        first: visual.first / 1000,
        refusal: `ChangeBeforeLaunch: the screen changed ${Math.round(visual.first)} ms into the recording, before the launch at ~${Math.round(launchAt)} ms`,
      };
    return { first: visual.first / 1000, visual: visual.complete - visual.first };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { first: 0, refusal: `${error.validator}: ${error.message}` };
  }
}

/** A cold launch: untimed setup, then the app is terminated and launched; times are from the process's start. */
async function launchRun(
  ctx: RunContext,
  state: FlowState,
  values: RunValues,
  refused: Record<string, string>,
): Promise<Filmed> {
  const { device, appId } = ctx;
  const c = ctx.case;
  if (c.setup) await runSteps(c.setup, state);
  await device.terminate(appId);
  await sleep(500);
  let recording: Recording | undefined;
  if (ctx.video) {
    recording = await device.record(ctx.video);
    await sleep(1000);
  }
  const launched = await launch(state);
  const start = launched.t0 + ctx.offset;
  if (launched.ttid !== undefined) values['launch.ttid'] = launched.ttid;
  const until = c.launch?.until?.slice('mark:'.length);
  if (until) {
    const mark = await ctx.tap.waitFor(
      (e) => e.kind === 'mark' && e.name === until && (e.pid === undefined || e.pid === launched.pid),
      start,
      ms(c.launch?.timeout ?? '30s'),
    );
    values['launch.ttfd'] = mark.t - start;
  }
  await sleep(ms(c.launch?.hold ?? (recording ? '3s' : '1s')));
  values['cpu.time'] = await device.cpuMs(launched.pid);
  const end = Date.now() + ctx.offset;
  await sleep(DRAIN_MS);
  await addMemory(values, ctx, launched.pid);
  addSdk(values, refused, ctx, { from: start, to: end, launched: start, pid: launched.pid });
  refuse(refused, UI_FRAME_METRICS, 'NotForCase: UI frame counts are for run cases');
  return { recording, action: launched.t0 };
}

/** A run or idle case: untimed setup, then the timed steps (or the idle wait) between two CPU readings. */
async function windowRun(
  ctx: RunContext,
  state: FlowState,
  values: RunValues,
  refused: Record<string, string>,
): Promise<Filmed> {
  const { device, appId } = ctx;
  const c = ctx.case;
  if (c.setup) await runSteps(c.setup, state);
  if (!state.launched) await launch(state);
  const pid = state.launched?.pid ?? 0;
  if (c.run) await device.prepareInput?.();
  await device.frames?.reset(appId);
  const recording = ctx.video ? await device.record(ctx.video) : undefined;
  if (recording) await sleep(1000);
  const cpuBefore = await device.cpuMs(pid);
  const start = Date.now();
  state.since = start + ctx.offset;
  if (c.idle) await sleep(ms(c.idle));
  else await runSteps(c.run ?? [], state);
  const end = Date.now();
  const cpu = (await device.cpuMs(pid)) - cpuBefore;
  // Frame counters keep counting: read them at the window's end, before the padding, drain and memory.
  const frames = await device.frames?.read(appId);
  values['cpu.time'] = cpu;
  if (c.idle) values['cpu.idle'] = cpu / ((end - start) / 1000);
  else values['run.duration'] = end - start;
  if (recording) await sleep(1000);
  await sleep(DRAIN_MS);
  await addMemory(values, ctx, pid);
  if (frames) {
    values['frames.total'] = frames.total;
    values['frames.janky'] = frames.janky;
    if (frames.total > 0) values['frames.janky.pct'] = (100 * frames.janky) / frames.total;
    else refused['frames.janky.pct'] = 'NoFrames: the app rendered no frames in the run';
    values['frames.p90'] = frames.p90;
  } else
    refuse(refused, UI_FRAME_METRICS, 'NotOnThisPlatform: no UI frame counts on the iOS Simulator without Instruments');
  addSdk(values, refused, ctx, {
    from: start + ctx.offset,
    to: end + ctx.offset,
    launched: (state.launched?.t0 ?? 0) + ctx.offset,
    pid,
  });
  return { recording, action: start };
}

/** One run of a case on an installed app; with `video`, the run is filmed (only filmed blocks pass one). */
export async function runOnce(ctx: RunContext): Promise<RunResult> {
  const values: RunValues = {};
  const refused: Record<string, string> = {};
  const state: FlowState = {
    device: ctx.device,
    appId: ctx.appId,
    tap: ctx.tap,
    dir: ctx.dir,
    since: Date.now() + ctx.offset,
    offset: ctx.offset,
    consumed: new Set(),
    alerts: ctx.bench.alerts,
  };
  const launchCase = caseKind(ctx.case) === 'launch';
  const { recording, action } = launchCase
    ? await launchRun(ctx, state, values, refused)
    : await windowRun(ctx, state, values, refused);
  const video = recording ? await analyseVideo(recording, values, refused, ctx.bench, launchCase, action) : undefined;
  return { values, refused, video };
}
