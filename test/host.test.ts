import { expect, test } from 'bun:test';
import {
  addByProgram,
  busiest,
  coresBetween,
  others,
  parsePs,
  programOf,
  summarize,
  watchOthers,
} from '../src/host.ts';

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

test('a block records the mean beside the busiest 5 s', () => {
  const intervals = [
    ...Array.from({ length: 10 }, () => ({ ms: 1000, cores: 1 })),
    ...Array.from({ length: 5 }, () => ({ ms: 1000, cores: 4 })),
  ];
  expect(summarize(intervals)).toEqual({ mean: 2, busiest: 4, top: [] });
});

test('other work is named by program, summed over its processes', () => {
  const a = {
    at: 0,
    byProc: new Map([
      ['1 /emu/qemu-system-aarch64 -avd a', 1000],
      ['2 /emu/qemu-system-aarch64 -avd b', 0],
    ]),
  };
  const b = {
    at: 2000,
    byProc: new Map([
      ['1 /emu/qemu-system-aarch64 -avd a', 2000],
      ['2 /emu/qemu-system-aarch64 -avd b', 1000],
      ['3 /usr/bin/java -jar gradle', 3000],
    ]),
  };
  const byProgram = new Map<string, number>();
  addByProgram(a, b, byProgram);
  expect(programOf('/Applications/Android Studio.app/Contents/jbr/bin/java')).toBe('java');
  expect(summarize([{ ms: 2000, cores: 2.5 }], byProgram).top).toEqual([
    { name: 'java', cores: 1.5 },
    { name: 'qemu-system-aarch64', cores: 1 },
  ]);
});

test('a program is named by its executable, even with spaces in the path', () => {
  const key = '7 /Applications/Android Studio.app/Contents/jbr/bin/java -jar gradle';
  const a = { at: 0, byProc: new Map([[key, 0]]) };
  const b = { at: 1000, byProc: new Map([[key, 500]]), names: new Map([[key, 'java']]) };
  const byProgram = new Map<string, number>();
  addByProgram(a, b, byProgram);
  expect([...byProgram]).toEqual([['java', 500]]);
});
