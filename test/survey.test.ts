import { expect, test } from 'bun:test';
import { parseGfxinfo } from '../src/android.ts';
import { allSteps, validate } from '../src/bench.ts';
import { transition } from '../src/visual.ts';

const W = 72;
const H = 156;
const frame = (gray: number, paint?: (x: number, y: number) => number | undefined) => {
  const f = new Uint8Array(W * H).fill(gray);
  if (paint)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const v = paint(x, y);
        if (v !== undefined) f[y * W + x] = v;
      }
  return f;
};
const hold = (f: Uint8Array, n: number) => Array.from({ length: n }, () => f);

test('a repeat step validates its body and flattens', () => {
  const bench = validate({
    cases: {
      leak: {
        run: [{ repeat: [{ open: 'app://b' }, { sleep: '1s' }, { open: 'app://a' }], times: 50 }],
        primary: 'memory.growth',
      },
    },
  });
  const run = bench.cases.leak?.run ?? [];
  expect(run).toEqual([{ repeat: [{ open: 'app://b' }, { sleep: '1s' }, { open: 'app://a' }], times: 50 }]);
  expect(allSteps(run)).toHaveLength(3);
  expect(() => validate({ cases: { a: { run: [{ repeat: [], times: 2 }], primary: 'cpu.time' } } })).toThrow(
    'at least one step',
  );
  expect(() =>
    validate({ cases: { a: { run: [{ repeat: [{ sleep: '1s' }], times: 0 }], primary: 'cpu.time' } } }),
  ).toThrow('whole number');
});

test('gfxinfo counts long frames from the histogram, not the GPU one', () => {
  const out = [
    'Total frames rendered: 240',
    'Janky frames: 31 (12.92%)',
    '90th percentile: 21ms',
    'HISTOGRAM: 5ms=200 50ms=10 95ms=3 100ms=2 150ms=1 4950ms=1',
    'GPU HISTOGRAM: 1ms=9 100ms=7',
  ].join('\n');
  expect(parseGfxinfo(out)).toEqual({ total: 240, janky: 31, p90: 21, long: 4 });
  expect(parseGfxinfo('Total frames rendered: 1\nJanky frames: 0\n90th percentile: 5ms').long).toBeUndefined();
});

test('a white flash between two dark screens counts once; a move to a light screen does not', () => {
  const dark = frame(20);
  const other = frame(20, (x, y) => (y > 60 && y < 90 && x > 10 ? 120 : undefined));
  const flash = transition([...hold(dark, 60), ...hold(frame(250), 4), ...hold(other, 60)]);
  expect(flash.flashes).toBe(1);
  expect(flash.events[0]).toMatchObject({ kind: 'flash-white' });
  expect(transition([...hold(dark, 60), ...hold(frame(250), 60)]).flashes).toBe(0);
});

test('a white strip at one edge is a flash too', () => {
  const dark = frame(20);
  const edge = frame(20, (x) => (x < 3 ? 255 : undefined));
  expect(transition([...hold(dark, 30), ...hold(edge, 3), ...hold(dark, 30)]).flashes).toBe(1);
});

test('a black flash on a light screen', () => {
  const light = frame(230);
  const t = transition([...hold(light, 30), ...hold(frame(0), 2), ...hold(light, 30)]);
  expect(t.events.map((e) => e.kind)).toEqual(['flash-black']);
});

test('a change after the screen held still is a jump; the longest stillness is the freeze', () => {
  const a = frame(20);
  const b = frame(20, (_, y) => (y < 40 ? 200 : undefined));
  const c = frame(20, (_, y) => (y < 80 ? 200 : undefined));
  // a, then b held 0.5 s, then c (content moved down) held to the end.
  const t = transition([...hold(a, 30), ...hold(b, 30), ...hold(c, 90)]);
  expect(t.jumps).toBe(1);
  expect(t.freeze).toBeGreaterThanOrEqual(480);
  expect(t.flashes).toBe(0);
  // A smooth transition with no pause: no jump, a short freeze.
  const smooth = transition([
    ...hold(a, 30),
    ...Array.from({ length: 20 }, (_, i) => frame(20 + i * 5)),
    ...hold(c, 60),
  ]);
  expect(smooth.jumps).toBe(0);
  expect(smooth.freeze).toBeLessThan(100);
});

test('a bright button sliding through an edge strip is not a flash; a recording with no change is refused', () => {
  const dark = frame(20);
  const button = frame(20, (x, y) => (y > H - 6 && x > 10 && x < 50 ? 230 : undefined));
  expect(transition([...hold(dark, 30), button, ...hold(dark, 30)]).flashes).toBe(0);
  expect(() => transition(hold(dark, 60))).toThrow('never changed');
});

test('a still stretch counts from its first frame to the change; 300 ms exactly is a jump', () => {
  const a = frame(20);
  const b = frame(20, (_, y) => (y < 40 ? 200 : undefined));
  const c = frame(20, (_, y) => (y < 80 ? 200 : undefined));
  const t = transition([...hold(a, 30), ...hold(b, 18), ...hold(c, 60)]);
  expect(t.freeze).toBe(300);
  expect(t.jumps).toBe(1);
});

test('two pulses in one region are two flashes', () => {
  const gray = frame(60);
  const white = frame(250);
  expect(transition([...hold(gray, 20), white, gray, white, ...hold(gray, 30)]).flashes).toBe(2);
});

test('a recording still changing at its end is not settled', () => {
  const t = transition(Array.from({ length: 90 }, (_, i) => frame(i % 2 ? 70 : 130)));
  expect(t.settled).toBe(false);
  expect(transition([...hold(frame(20), 30), ...hold(frame(90), 40)]).settled).toBe(true);
});
