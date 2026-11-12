import { expect, test } from 'bun:test';
import { validate } from '../src/bench.ts';
import { countersIn, marksIn, parseSdkLine } from '../src/events.ts';
import { psTime } from '../src/host.ts';
import { visualTimes } from '../src/visual.ts';

test('SDK lines parse whatever the logger put before them', () => {
  expect(parseSdkLine('2026-11-12 E App[1:2] [com.facebook.react.log:javascript] [doubletake] m 1000 home')).toEqual({
    kind: 'mark',
    t: 1000,
    name: 'home',
  });
  expect(parseSdkLine('I ReactNativeJS: [doubletake] s 5 fn')).toEqual({
    kind: 'start',
    t: 5,
    frames: true,
    network: true,
  });
  expect(parseSdkLine('[doubletake] s 5 -')).toEqual({ kind: 'start', t: 5, frames: false, network: false });
  expect(parseSdkLine('[doubletake] f 9 2 33')).toEqual({ kind: 'frame', t: 9, missed: 2, late: 33 });
  expect(parseSdkLine('[doubletake] r 9')).toBeNull();
  expect(parseSdkLine('unrelated')).toBeNull();
});

test('a window counts the events inside it, in the process reporting at its end', () => {
  const events = [
    '[doubletake] s 0 fn',
    '[doubletake] r 100 500',
    '[doubletake] s 1000 fn',
    '[doubletake] f 1100 1 20',
    '[doubletake] r 1150 300',
    '[doubletake] f 1300 2 40',
    '[doubletake] m 1350 home',
    '[doubletake] r 1500 100',
  ]
    .map(parseSdkLine)
    .filter((e) => e !== null);
  expect(countersIn(events, 900, 1400, 990)?.counters).toMatchObject({
    dropped: 3,
    stall: 60,
    requests: 1,
    bytes: 300,
  });
  expect(countersIn(events, 1200, 1400, 990)?.counters).toMatchObject({ dropped: 2, requests: 0 });
  expect(countersIn(events, 2000, 2400, 1990)).toBeUndefined();
  expect(countersIn([], 0, 1, 0)).toBeUndefined();
  expect(marksIn(events, 1000, 2000).get('home')).toBe(1350);
  expect(marksIn(events, 1000, 1300).has('home')).toBe(false);
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
  expect(psTime('2-00:00:01')).toBe(172801000);
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
