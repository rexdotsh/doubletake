export type Better = 'lower' | 'higher';
type Unit = 'ms' | 'MiB' | 'count' | 'bytes' | '%' | 'ms/s';
export type Platform = 'ios' | 'android';

export type MetricInfo = {
  unit: Unit;
  better: Better;
  /** Where the number comes from, as the report's method section says it. */
  source: string;
  platforms: readonly Platform[];
  /** Needs the doubletake SDK in the app. */
  sdk?: true;
};

const both = ['ios', 'android'] as const;

export const METRICS: Record<string, MetricInfo> = {
  'launch.ttid': {
    unit: 'ms',
    better: 'lower',
    source: '`am start -W` TotalTime: the launch to the first frame',
    platforms: ['android'],
  },
  'launch.ttfd': {
    unit: 'ms',
    better: 'lower',
    source: "the launch command to the case's `until` mark",
    platforms: both,
    sdk: true,
  },
  'launch.visual': {
    unit: 'ms',
    better: 'lower',
    source:
      'screen recording: the first changed frame to the frame after which the screen stays within 1% of its final image',
    platforms: both,
  },
  'run.duration': {
    unit: 'ms',
    better: 'lower',
    source: "the run's steps, wall time on the device host",
    platforms: both,
  },
  'cpu.time': {
    unit: 'ms',
    better: 'lower',
    source: "the app process's user + system CPU time over the run",
    platforms: both,
  },
  'cpu.idle': {
    unit: 'ms/s',
    better: 'lower',
    source: "the app's CPU time per second while it sits on a screen untouched",
    platforms: both,
  },
  'memory.peak': {
    unit: 'MiB',
    better: 'lower',
    source: "iOS: footprint's peak physical footprint; Android: VmHWM (peak RSS)",
    platforms: both,
  },
  'memory.end': {
    unit: 'MiB',
    better: 'lower',
    source: 'iOS: physical footprint; Android: PSS from `dumpsys meminfo`, at the end of the run',
    platforms: both,
  },
  'frames.total': {
    unit: 'count',
    better: 'higher',
    source: '`dumpsys gfxinfo`: frames the UI thread rendered in the run',
    platforms: ['android'],
  },
  'frames.janky': {
    unit: 'count',
    better: 'lower',
    source: '`dumpsys gfxinfo`: janky frames in the run',
    platforms: ['android'],
  },
  'frames.janky.pct': {
    unit: '%',
    better: 'lower',
    source: '`dumpsys gfxinfo`: janky frames as a share of rendered frames',
    platforms: ['android'],
  },
  'frames.p90': {
    unit: 'ms',
    better: 'lower',
    source: '`dumpsys gfxinfo`: 90th percentile frame time',
    platforms: ['android'],
  },
  'js.frames.dropped': {
    unit: 'count',
    better: 'lower',
    source: 'SDK: JS frames (requestAnimationFrame) that came late, in frame intervals',
    platforms: both,
    sdk: true,
  },
  'js.stall': {
    unit: 'ms',
    better: 'lower',
    source: 'SDK: time JS frames were late beyond one interval (a busy JS thread)',
    platforms: both,
    sdk: true,
  },
  'net.requests': {
    unit: 'count',
    better: 'lower',
    source: 'SDK: XMLHttpRequest/fetch requests that finished',
    platforms: both,
    sdk: true,
  },
  'net.bytes': {
    unit: 'bytes',
    better: 'lower',
    source: 'SDK: response bytes (Content-Length, else the body)',
    platforms: both,
    sdk: true,
  },
  'react.commits': {
    unit: 'count',
    better: 'lower',
    source: 'SDK `onRender`: React Profiler commits (profiling builds only)',
    platforms: both,
    sdk: true,
  },
  'react.render': {
    unit: 'ms',
    better: 'lower',
    source: 'SDK `onRender`: React Profiler actual render time (profiling builds only)',
    platforms: both,
    sdk: true,
  },
};

export function metricInfo(name: string): MetricInfo | undefined {
  if (name.startsWith('mark.'))
    return {
      unit: 'ms',
      better: 'lower',
      source: 'the launch (or run start) to the SDK mark',
      platforms: both,
      sdk: true,
    };
  return METRICS[name];
}

/** Counts compare exactly when stable; everything with a unit of time or size compares by log ratio. */
export function isCount(name: string): boolean {
  return metricInfo(name)?.unit === 'count';
}

export function words(name: string): [better: string, worse: string] {
  const info = metricInfo(name);
  if (!info) return ['better', 'worse'];
  if (info.unit === 'ms') return ['faster', 'slower'];
  if (info.unit === 'count') return info.better === 'lower' ? ['fewer', 'more'] : ['more', 'fewer'];
  return info.better === 'lower' ? ['less', 'more'] : ['more', 'less'];
}
