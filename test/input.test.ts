import { expect, test } from 'bun:test';
import { find, inPoints, parseTree, promptOf } from '../src/axe.ts';
import { validate } from '../src/bench.ts';
import { maestroCommands } from '../src/maestro.ts';

const tap = (t: unknown) => validate({ cases: { a: { run: [{ tap: t }], primary: 'cpu.time' } } });

/** A 1000x2000-pixel screen at 2 pixels per dp. */
const px = (at: [number, number] | { points: [number, number] }): [number, number] =>
  Array.isArray(at) ? [at[0] * 1000, at[1] * 2000] : [at.points[0] * 2, at.points[1] * 2];

const frame = (x: number, y: number, width = 100, height = 40) => ({ x, y, width, height });

// Shaped like `axe describe-ui` while iOS asks "Open in …?": SpringBoard, an application without a label.
const springboard = [
  {
    type: 'Application',
    AXLabel: ' ',
    frame: frame(0, 0, 402, 874),
    children: [
      {
        type: 'Sheet',
        AXLabel: 'Open in “App”?',
        frame: frame(41, 388, 320, 126),
        children: [
          { type: 'StaticText', AXLabel: 'Open in “App”?', frame: frame(71, 409) },
          { type: 'Button', AXLabel: 'Cancel', frame: frame(57, 450, 140, 48) },
          { type: 'Button', AXLabel: 'Open', frame: frame(205, 450, 140, 48) },
        ],
      },
    ],
  },
];

const app = [
  {
    type: 'Application',
    AXLabel: 'App',
    frame: frame(0, 0, 402, 874),
    children: [
      { type: 'Button', AXLabel: 'Pack', AXUniqueId: 'pack-card', frame: frame(220, 300) },
      { type: 'Button', AXLabel: 'Pack', AXUniqueId: 'pack-card', frame: frame(20, 300) },
      { type: 'Button', AXLabel: 'Pack', AXUniqueId: 'pack-card', frame: frame(20, 100) },
      { type: 'Alert', AXLabel: 'In-app alert', frame: frame(40, 400) },
    ],
  },
];

test('a system prompt is read from SpringBoard, an in-app alert is not one', () => {
  const prompt = promptOf(parseTree(springboard));
  expect(prompt?.text).toBe('Open in “App”?');
  expect(prompt?.buttons.map((b) => b.label)).toEqual(['Cancel', 'Open']);
  expect(promptOf(parseTree(app))).toBeUndefined();
});

test('matches count top to bottom, then left to right', () => {
  const { elements } = parseTree(app);
  expect(find(elements, { id: 'pack-card' }).map((e) => [e.frame.x, e.frame.y])).toEqual([
    [20, 100],
    [20, 300],
    [220, 300],
  ]);
  expect(find(elements, { label: 'Missing' })).toEqual([]);
});

test('points are fractions of the screen or points, never guessed from the size', () => {
  expect(inPoints([0.5, 1], { w: 400, h: 800 })).toEqual([200, 800]);
  expect(inPoints({ points: [1, 1] }, { w: 400, h: 800 })).toEqual([1, 1]);
});

test('a bench says which unit a point is in, and how to pick one of several elements', () => {
  expect(() => tap([200, 400])).toThrow(/write \{ points: \[x, y\] \} for points/);
  expect(() => tap({ id: 'pack-card', index: -1 })).toThrow(/index is a whole number/);
  expect(() => tap({ id: 'a', label: 'b' })).toThrow(/unknown key label/);
  expect(tap({ points: [200, 400] }).cases.a?.run).toEqual([{ tap: { points: [200, 400] } }]);
  expect(tap({ id: 'pack-card', index: 2 }).cases.a?.run).toEqual([{ tap: { id: 'pack-card', index: 2 } }]);
  expect(validate({ alerts: ['Allow'], cases: { a: { launch: {}, primary: 'launch.ttid' } } }).alerts).toEqual([
    'Allow',
  ]);
});

test('Maestro gets pixels and whole-text matches', () => {
  expect(
    maestroCommands(
      [{ tap: 'Buy (1)' }, { tap: { id: 'pack-card', index: 1 } }, { tap: { points: [10, 20] } }, { tap: [0.5, 0.5] }],
      px,
    ),
  ).toEqual([
    'tapOn:\n    text: "Buy \\\\(1\\\\)"',
    'tapOn:\n    id: "pack-card"\n    index: 1',
    'tapOn:\n    point: "20,40"',
    'tapOn:\n    point: "500,1000"',
  ]);
});
