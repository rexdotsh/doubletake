import { expect, test } from 'bun:test';
import { busiest, coresBetween, others, parsePs, watchOthers } from '../src/host.ts';

const ps = `  1     0   1:00.00 /sbin/launchd
 100     1   0:10.00 node doubletake.mjs bench
 101   100   0:01.00 xcrun simctl launch ABCD app
 200     1   0:30.00 /CoreSimulator/Devices/ABCD/launchd_sim
 201   200   0:05.00 /CoreSimulator/Devices/ABCD/data/App.app/App
 300     1   2:00.00 xcodebuild -scheme Other`;

test('doubletake and the device are not other work; their children neither', () => {
  expect(others(parsePs(ps), 100, (command) => command.includes('ABCD/launchd_sim')).map((p) => p.pid)).toEqual([
    1, 300,
  ]);
});

test('cores used between two snapshots count new processes whole', () => {
  const a = { at: 0, byProc: new Map([['300 xcodebuild', 120_000]]) };
  const b = {
    at: 10_000,
    byProc: new Map([
      ['300 xcodebuild', 140_000],
      ['301 clang', 5_000],
    ]),
  };
  expect(coresBetween(a, b)).toBe(2.5);
});

test('a short burst shows in the busiest 5 s, not diluted over the block', () => {
  const quietSecond = { ms: 1000, cores: 0.5 };
  const intervals = [
    ...Array.from({ length: 10 }, () => quietSecond),
    ...Array.from({ length: 5 }, () => ({ ms: 1000, cores: 8 })),
    ...Array.from({ length: 10 }, () => quietSecond),
  ];
  expect(busiest(intervals, 5000)).toBe(8);
});

test('a reused pid with another command is a new process', () => {
  const a = { at: 0, byProc: new Map([['400 old', 60_000]]) };
  const b = { at: 1000, byProc: new Map([['400 new', 800]]) };
  expect(coresBetween(a, b)).toBe(0.8);
});

test('a failing sample is held until stop, not thrown into the void', async () => {
  const watch = watchOthers(() => {
    throw new Error('ps failed');
  });
  const error = await watch.stop().then(
    () => '',
    (e: unknown) => String(e),
  );
  expect(error).toContain('ps failed');
});
