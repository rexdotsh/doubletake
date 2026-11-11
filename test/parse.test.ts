import { expect, test } from 'bun:test';
import { validate } from '../src/bench.ts';
import { countersIn, marksAfter, parseSdkLine } from '../src/events.ts';
import { psTime } from '../src/ios.ts';
import { visualTimes } from '../src/visual.ts';

test('SDK lines parse whatever the logger put before them', () => {
  expect(parseSdkLine('2026-11-12 E App[1:2] [com.facebook.react.log:javascript] [doubletake] m 1000 home')).toEqual({
    kind: 'mark',
    t: 1000,
    name: 'home',
  });
  expect(parseSdkLine('I ReactNativeJS: [doubletake] s 5')).toEqual({ kind: 'start', t: 5 });
  expect(parseSdkLine('[doubletake] c 9 1 2 3 4 5 6 7')).toEqual({
    kind: 'counters',
    t: 9,
    frames: 1,
    dropped: 2,
    stall: 3,
    requests: 4,
    bytes: 5,
    commits: 6,
    render: 7,
  });
  expect(parseSdkLine('[doubletake] c 9 1 2')).toBeNull();
  expect(parseSdkLine('unrelated')).toBeNull();
});

test('counters in a window count from the process running at its end', () => {
  const events = [
    parseSdkLine('[doubletake] s 0'),
    parseSdkLine('[doubletake] c 100 10 1 20 1 100 0 0'),
    parseSdkLine('[doubletake] s 1000'),
    parseSdkLine('[doubletake] c 1100 5 0 0 0 0 0 0'),
    parseSdkLine('[doubletake] c 1300 30 3 50 2 300 0 0'),
    parseSdkLine('[doubletake] m 1350 home'),
  ].filter((e) => e !== null);
  expect(countersIn(events, 900, 1400)).toMatchObject({ frames: 30, dropped: 3, requests: 2 });
  expect(countersIn(events, 1200, 1400)).toMatchObject({ frames: 25, dropped: 3 });
  expect(countersIn([], 0, 1)).toBeUndefined();
  expect(marksAfter(events, 1000).get('home')).toBe(1350);
});

test('bench files are checked with the nearest key', () => {
  const ok = validate({
    app: { ios: 'x' },
    cases: { start: { launch: { until: 'mark:home' }, primary: 'launch.ttfd' } },
  });
  expect(ok.cases.start?.launch?.until).toBe('mark:home');
  expect(() => validate({ cases: { a: { launch: {}, primray: 'launch.ttfd' } } })).toThrow(/did you mean primary/);
  expect(() => validate({ cases: { a: { launch: {}, primary: 'lanch.ttfd' } } })).toThrow(/did you mean launch.ttfd/);
  expect(() => validate({ cases: { a: { run: [{ sleep: '2' }], primary: 'cpu.time' } } })).toThrow(/needs its unit/);
  expect(() => validate({ cases: { a: { run: [], idle: '2s', primary: 'cpu.idle' } } })).toThrow(/exactly one/);
});

test('ps time reads minutes and hours', () => {
  expect(psTime('0:01.23')).toBe(1230);
  expect(psTime('1:02:03.50')).toBe(3723500);
});

function frame(level: number): Uint8Array {
  return new Uint8Array(72 * 156).fill(level);
}

test('visual times run from the first change to the last frame unlike the end', () => {
  const frames = [
    ...Array.from({ length: 30 }, () => frame(0)),
    ...Array.from({ length: 30 }, () => frame(100)),
    ...Array.from({ length: 90 }, () => frame(200)),
  ];
  const v = visualTimes(frames);
  expect(v.first).toBeCloseTo(500, 0);
  expect(v.complete).toBeCloseTo(1000, 0);
});

test('a screen still changing at the end is refused', () => {
  const frames = Array.from({ length: 120 }, (_, i) => frame(i % 2 ? 0 : 255));
  expect(() => visualTimes(frames)).toThrow(/still changing/);
});
