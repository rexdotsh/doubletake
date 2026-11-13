import { expect, test } from 'bun:test';
import { validate } from '../src/bench.ts';
import { parseSdkLine } from '../src/events.ts';
import { metricInfo } from '../src/metrics.ts';
import { androidMark, iosMark, osLogTime, phasesOf, waterfall } from '../src/timeline.ts';
import { timelineSvg, timelineText, timelines } from '../src/waterfall.ts';
import type { Experiment } from '../src/store.ts';

const pkg = 'dev.example.app';
// A cold launch on an Android emulator, logcat -v epoch, trimmed to the lines that matter and some that must not.
const LOGCAT = `
1763030400.100  1500  1530 I ActivityTaskManager: START u0 {act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] flg=0x10000000 cmp=${pkg}/.MainActivity} with LAUNCH_MULTIPLE from uid 2000 (BAL_ALLOW_PERMISSION) result code=0
1763030400.131  1500  1561 I ActivityManager: Start proc 4242:${pkg}/u0a190 for next-top-activity {${pkg}/${pkg}.MainActivity}
1763030400.140  1500  1561 I ActivityManager: Start proc 4300:com.other.app/u0a191 for service {com.other.app/.Sync}
1763030400.443  4242  4300 W unknown:BridgelessReact: ReactHost{0}.getOrCreateReactInstanceTask(): Start
1763030400.444  4242  4300 W unknown:BridgelessReact: ReactHost{0}.getJSBundleLoader()
1763030400.535  4242  4300 W unknown:BridgelessReact: ReactHost{0}.getOrCreateReactInstanceTask(): Loading JS Bundle
1763030401.020  4242  4290 I ReactNativeJS: [perf-mark] i18n_ready 1763030401019
1763030401.300  4242  4290 I ReactNativeJS: Running "main"
1763030401.512  1500  1544 I ActivityTaskManager: Displayed ${pkg}/.MainActivity for user 0: +1s412ms
1763030401.600  4300  4310 I ReactNativeJS: Running "main"
1763030401.998  4242  4242 D SplashScreenView: remove starting view
1763030403.200  4242  4290 I ReactNativeJS: [perf-mark] home_interactive 1763030403198.5
1763030404.000  1500  1544 I ActivityTaskManager: Fully drawn ${pkg}/.MainActivity: +3s900ms
1763030404.100  1500  1544 I ActivityTaskManager: Displayed com.other.app/.Main for user 0: +200ms
`;

test('android: the platform marks a launch of the app, and app marks keep their own clock', () => {
  const lines = LOGCAT.trim().split('\n');
  const marks = lines.map((l) => androidMark(l, pkg)).filter((m) => m !== null);
  expect(marks.map((m) => [m.name, m.t, m.pid])).toEqual([
    ['rn.start', 1_763_030_400_443, 4242],
    ['js.load', 1_763_030_400_535, 4242],
    ['js.run', 1_763_030_401_300, 4242],
    ['first.frame', 1_763_030_401_512, undefined],
    ['js.run', 1_763_030_401_600, 4300],
    ['splash.removed', 1_763_030_401_998, 4242],
    ['fully.drawn', 1_763_030_404_000, undefined],
  ]);
  expect(marks.every((m) => m.os)).toBe(true);
  const app = lines.map((l) => parseSdkLine(l)).filter((e) => e !== null);
  expect(app).toEqual([
    { kind: 'mark', t: 1_763_030_401_019, name: 'i18n_ready' },
    { kind: 'mark', t: 1_763_030_403_198.5, name: 'home_interactive' },
  ]);
});

test('ios: log stream timestamps and React Native lines', () => {
  expect(osLogTime('2026-11-13 10:00:00.123456+0100')).toBeCloseTo(Date.UTC(2026, 10, 13, 9, 0, 0, 123) + 0.456, 3);
  expect(osLogTime('2026-11-13 10:00:00-0000')).toBe(Date.UTC(2026, 10, 13, 10, 0, 0));
  expect(osLogTime('yesterday')).toBeNaN();
  expect(iosMark('Running "main" with {"rootTag":1}', 5, 77)).toEqual({
    kind: 'mark',
    t: 5,
    name: 'js.run',
    os: true,
    pid: 77,
  });
  expect(iosMark('unrelated', 5)).toBeNull();
  expect(parseSdkLine('2026-11-13 App[77:9] [com.facebook.react.log:javascript] [perf-mark] app_ready 1000')).toEqual({
    kind: 'mark',
    t: 1000,
    name: 'app_ready',
  });
  expect(parseSdkLine('[perf-mark] no-time')).toBeNull();
});

test('phases are the gaps between consecutive marks, in the order the launch wrote them', () => {
  const marks = new Map([
    ['home', 900],
    ['process.start', 30],
    ['js.run', 400],
    ['early', -5],
  ]);
  expect(phasesOf(marks)).toEqual([
    { from: 'start', to: 'process.start', ms: 30 },
    { from: 'process.start', to: 'js.run', ms: 370 },
    { from: 'js.run', to: 'home', ms: 500 },
  ]);
});

test('the median waterfall reports a mark some launches missed, and never invents it', () => {
  const w = waterfall([
    { a: 10, b: 100, c: 300 },
    { a: 20, b: 120, c: 280 },
    { a: 30, c: 350 },
  ]);
  expect(w.marks).toEqual([
    { name: 'a', at: 20, n: 3 },
    { name: 'b', at: 110, n: 2 },
    { name: 'c', at: 300, n: 3 },
  ]);
  expect(w.phases).toEqual([
    { from: 'start', to: 'a', start: 0, ms: 20, n: 3 },
    { from: 'a', to: 'b', start: 20, ms: 95, n: 2 },
    { from: 'b', to: 'c', start: 110, ms: 180, n: 2 },
  ]);
});

test('timeline cases and phase metrics validate', () => {
  const bench = validate({
    app: { android: pkg },
    cases: {
      cold: { launch: { timeline: true, until: 'mark:home' }, primary: 'mark.home', metrics: ['phase.js.run->home'] },
    },
  });
  expect(bench.cases.cold?.launch?.timeline).toBe(true);
  expect(metricInfo('phase.start->rn.start')?.unit).toBe('ms');
  expect(metricInfo('phase.nope')).toBeUndefined();
  expect(() => validate({ cases: { c: { launch: { timeline: 'yes' }, primary: 'cpu.time' } } })).toThrow(
    'true or false',
  );
});

test('a timeline names each side, missing marks and the A/B of each phase, as text and SVG', () => {
  const e: Experiment = {
    schema: 'doubletake.experiment.v1',
    id: 'exp_t',
    kind: 'experiment',
    created: '2026-01-01T00:00:00Z',
    file: 'app.bench.ts',
    comparison: 'builds',
    device: { platform: 'android', name: 'emulator', os: '16', id: 'emulator-5554', host: '' },
    variants: [
      { role: 'base', label: 'main', appId: pkg, spec: 'a.apk' },
      { role: 'head', label: 'pr', appId: pkg, spec: 'b.apk' },
    ],
    plan: { pairs: 8, runs: 3, warmup_runs: 1, warmup_blocks: 1, order: 'ABBA', install: 'sequential' },
    decided: true,
    series: [
      {
        case: 'cold <start>',
        primary: {
          metric: 'phase.js.run->home',
          n: 8,
          base: 500,
          head: 400,
          estimate: -0.2,
          lo: -0.25,
          hi: -0.15,
          relative: true,
          confidence: 0.9842,
          p: 0.01,
          bound: 0.02,
          better: 'lower',
          verdict_kind: 'better',
          decided: true,
          needed_pairs: 6,
        },
        secondaries: [],
        refused: { 'mark.privy_ready': 'NoMarker: the run wrote no privy_ready mark', 'cpu.time': 'x' },
        pairs: 8,
        stopped: 'decided at 8 pairs',
        minutes: 3,
      },
    ],
    checks: [],
    warnings: [],
  };
  const launches = new Map([
    [
      'cold <start>',
      new Map([
        [
          'base' as const,
          [
            { 'js.run': 400, home: 900 },
            { 'js.run': 420, home: 940 },
          ],
        ],
        ['head' as const, [{ 'js.run': 410, home: 800 }, { home: 820 }]],
      ]),
    ],
  ]);
  const [t] = timelines(e, launches);
  if (!t) throw new Error('no timeline');
  expect(t.sides.map((s) => s.label)).toEqual(['main', 'pr']);
  expect(t.refused).toEqual({ 'mark.privy_ready': 'NoMarker: the run wrote no privy_ready mark' });
  const text = timelineText(t, 'android');
  expect(text).toContain('missing: js.run in 1 of 2 launches');
  expect(text).toContain('phase.js.run->home');
  expect(text).toContain('faster');
  expect(text).toContain('mark.privy_ready: refused: NoMarker');
  const svg = timelineSvg(t);
  expect(svg).toStartWith('<svg');
  expect(svg).toContain('cold &lt;start&gt;');
  expect(svg).not.toContain('NaN');
});
