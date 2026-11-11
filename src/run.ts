import type { Bench, Case } from './bench.ts';
import { caseKind, ms } from './bench.ts';
import type { Device, LogTap, Recording, Usage } from './device.ts';
import { Refusal } from './device.ts';
import { countersIn, marksAfter } from './events.ts';
import { type FlowState, launch, runSteps } from './flow.ts';
import { sleep } from './sh.ts';
import { decodeFrames, visualTimes } from './visual.ts';

type RunValues = Record<string, number>;
export type RunResult = {
  values: RunValues;
  /** Metrics the run could not give, with the reason. */
  refused: Record<string, string>;
  video?: string;
};

export type RunContext = {
  device: Device;
  appId: string;
  bench: Bench;
  name: string;
  case: Case;
  tap: LogTap;
  offset: number;
  dir: string;
  /** Where this run's video goes, when the run is filmed. */
  video?: string;
};

/** A visual primary needs a recording of every run; so does a run asked to be filmed. */
export function filmed(c: Case): boolean {
  return c.primary === 'launch.visual' || (c.metrics ?? []).includes('launch.visual') || c.launch?.visual === true;
}

function addUsage(values: RunValues, before: Usage | undefined, after: Usage): void {
  values['cpu.time'] = after.cpuMs - (before?.cpuMs ?? 0);
  if (after.memoryPeakMiB !== undefined) values['memory.peak'] = after.memoryPeakMiB;
  if (after.memoryEndMiB !== undefined) values['memory.end'] = after.memoryEndMiB;
}

function addSdk(values: RunValues, refused: Record<string, string>, ctx: RunContext, from: number, to: number): void {
  const counters = countersIn(ctx.tap.events, from, to);
  if (!counters) {
    for (const m of ['js.frames.dropped', 'js.stall', 'net.requests', 'net.bytes', 'react.commits', 'react.render'])
      refused[m] = 'NoSdk: the app wrote no doubletake lines (import and start() the SDK)';
    return;
  }
  values['js.frames.dropped'] = counters.dropped;
  values['js.stall'] = counters.stall;
  values['net.requests'] = counters.requests;
  values['net.bytes'] = counters.bytes;
  if (counters.commits > 0) {
    values['react.commits'] = counters.commits;
    values['react.render'] = counters.render;
  } else
    refused['react.commits'] = refused['react.render'] =
      'NoProfiler: no React Profiler commits (a release build, or no onRender)';
}

async function analyseVideo(
  recording: Recording,
  values: RunValues,
  refused: Record<string, string>,
  bench: Bench,
): Promise<string> {
  const file = await recording.stop();
  try {
    const visual = visualTimes(await decodeFrames(file), bench.ignore);
    values['launch.visual'] = visual.complete - visual.first;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    refused['launch.visual'] = `${error.validator}: ${error.message}`;
  }
  return file;
}

/** One run of a case on an installed app. */
export async function runOnce(ctx: RunContext): Promise<RunResult> {
  const { device, appId } = ctx;
  const c = ctx.case;
  const values: RunValues = {};
  const refused: Record<string, string> = {};
  const state: FlowState = {
    device,
    appId,
    tap: ctx.tap,
    dir: ctx.dir,
    since: Date.now() + ctx.offset,
    offset: ctx.offset,
  };
  const kind = caseKind(c);
  let recording: Recording | undefined;

  if (kind === 'launch') {
    await device.terminate(appId);
    await sleep(500);
    if (ctx.video) {
      recording = await device.record(ctx.video);
      await sleep(1000);
    }
    const launched = await launch(state);
    const start = launched.t0 + ctx.offset;
    if (launched.ttid !== undefined) values['launch.ttid'] = launched.ttid;
    const until = c.launch?.until?.slice('mark:'.length);
    if (until) {
      const at = await ctx.tap.waitFor(
        (e) => e.kind === 'mark' && e.name === until,
        start,
        ms(c.launch?.timeout ?? '30s'),
      );
      values['launch.ttfd'] = at - start;
    }
    await sleep(ms(c.launch?.hold ?? (recording ? '3s' : '1s')));
    addUsage(values, undefined, await device.usage(launched.pid, appId));
    for (const [name, at] of marksAfter(ctx.tap.events, start)) values[`mark.${name}`] = at - start;
    addSdk(values, refused, ctx, start - 1, Date.now() + ctx.offset);
  } else {
    if (c.setup) await runSteps(c.setup, state);
    if (!state.launched) await launch(state);
    const pid = state.launched?.pid ?? 0;
    const before = await device.usage(pid, appId);
    await device.frames?.reset(appId);
    const start = Date.now();
    state.since = start + ctx.offset;
    if (kind === 'idle') await sleep(ms(c.idle ?? '10s'));
    else await runSteps(c.run ?? [], state);
    const end = Date.now();
    // Counters reach the log up to one SDK interval (250 ms) late.
    await sleep(400);
    const after = await device.usage(pid, appId);
    addUsage(values, before, after);
    if (kind === 'idle') values['cpu.idle'] = (values['cpu.time'] ?? 0) / ((end - start) / 1000);
    else values['run.duration'] = end - start;
    if (device.frames) {
      const frames = await device.frames.read(appId);
      values['frames.total'] = frames.total;
      values['frames.janky'] = frames.janky;
      values['frames.janky.pct'] = frames.total ? (100 * frames.janky) / frames.total : 0;
      values['frames.p90'] = frames.p90;
    } else
      for (const m of ['frames.total', 'frames.janky', 'frames.janky.pct', 'frames.p90'])
        refused[m] = 'NotOnThisPlatform: no UI frame counts on the iOS Simulator without Instruments';
    for (const [name, at] of marksAfter(ctx.tap.events, start + ctx.offset))
      values[`mark.${name}`] = at - (start + ctx.offset);
    addSdk(values, refused, ctx, start + ctx.offset, end + ctx.offset);
  }
  const video = recording ? await analyseVideo(recording, values, refused, ctx.bench) : undefined;
  return { values, refused, video };
}
