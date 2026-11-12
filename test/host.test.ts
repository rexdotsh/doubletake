import { expect, test } from 'bun:test';
import { coresBetween, others, parsePs } from '../src/host.ts';

const ps = `  1     0   1:00.00 /sbin/launchd
 100     1   0:10.00 node doubletake.mjs bench
 101   100   0:01.00 xcrun simctl launch ABCD app
 200     1   0:30.00 /CoreSimulator/Devices/ABCD/launchd_sim
 201   200   0:05.00 /CoreSimulator/Devices/ABCD/data/App.app/App
 300     1   2:00.00 xcodebuild -scheme Other`;

test('doubletake and the device are not other work; their children neither', () => {
  expect(others(parsePs(ps), 100, ['ABCD']).map((p) => p.pid)).toEqual([1, 300]);
});

test('cores used between two snapshots count new processes whole', () => {
  const a = { at: 0, byPid: new Map([[300, 120_000]]) };
  const b = {
    at: 10_000,
    byPid: new Map([
      [300, 140_000],
      [301, 5_000],
    ]),
  };
  expect(coresBetween(a, b)).toBe(2.5);
});
