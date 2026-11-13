import { expect, test } from 'bun:test';
import { Refusal } from '../src/device.ts';
import { validate } from '../src/bench.ts';
import type { Device, LogTap } from '../src/device.ts';
import { checkCase } from '../src/experiment.ts';
import { RecorderStuck, runOnce } from '../src/run.ts';

test('a check records a case that throws, refused on its primary, instead of ending', async () => {
  expect(await checkCase('cpu.idle', async () => ({ values: { 'cpu.idle': 5 }, refused: {} }))).toEqual({
    values: { 'cpu.idle': 5 },
    refused: {},
  });
  expect(
    await checkCase('cpu.idle', async () => {
      throw new Error('shell step exited 1');
    }),
  ).toEqual({ values: {}, refused: { 'cpu.idle': 'Failed: shell step exited 1' } });
  expect(
    await checkCase('cpu.idle', async () => {
      throw new Refusal('NoMarker', 'no matching SDK line within 30000 ms');
    }),
  ).toEqual({ values: {}, refused: { 'cpu.idle': 'NoMarker: no matching SDK line within 30000 ms' } });
});

test('a filmed run that fails stops its recorder before the error goes on', async () => {
  let stops = 0;
  const device = {
    platform: 'android',
    id: 'fake',
    name: 'fake',
    os: 'fake',
    isHostProcess: () => false,
    prepare: async () => undefined,
    appId: async () => 'app',
    install: async () => undefined,
    uninstall: async () => undefined,
    isInstalled: async () => true,
    terminate: async () => undefined,
    launch: async () => ({ t0: Date.now(), pid: 1 }),
    cpuMs: async () => 0,
    memory: async () => ({}),
    logs: async () => tap,
    clockOffset: async () => 0,
    record: async () => ({
      stop: async () => {
        stops++;
        return 'x.mp4';
      },
    }),
    openUrl: async () => undefined,
    input: async () => undefined,
  } satisfies Device;
  const tap: LogTap = { events: [], waitFor: () => Promise.reject(new Error('none')), stop: async () => undefined };
  const c = validate({ cases: { a: { run: [{ shell: 'exit 1' }], primary: 'visual.flashes' } } }).cases.a;
  if (!c) throw new Error('no case');
  const failed = await runOnce({
    device,
    appId: 'app',
    bench: { app: {}, cases: {} },
    case: c,
    tap,
    offset: 0,
    dir: '.',
    video: 'x.mp4',
  }).then(
    () => false,
    () => true,
  );
  expect(failed).toBe(true);
  expect(stops).toBe(1);
  const stuck = await runOnce({
    device: { ...device, record: async () => ({ stop: () => Promise.reject(new Error('adb gone')) }) },
    appId: 'app',
    bench: { app: {}, cases: {} },
    case: c,
    tap,
    offset: 0,
    dir: '.',
    video: 'x.mp4',
  }).then(
    () => 'ok',
    (error: unknown) => (error instanceof RecorderStuck ? 'stuck' : 'other'),
  );
  expect(stuck).toBe('stuck');
  // A run that worked but whose recorder won't stop ends the check too.
  const ok = validate({ cases: { a: { run: [{ sleep: '1ms' }], primary: 'visual.flashes' } } }).cases.a;
  if (!ok) throw new Error('no case');
  const stuckAfter = await runOnce({
    device: { ...device, record: async () => ({ stop: () => Promise.reject(new Error('adb gone')) }) },
    appId: 'app',
    bench: { app: {}, cases: {} },
    case: ok,
    tap,
    offset: 0,
    dir: '.',
    video: 'x.mp4',
  }).then(
    () => 'ok',
    (error: unknown) => (error instanceof RecorderStuck ? 'stuck' : String(error)),
  );
  expect(stuckAfter).toBe('stuck');
});

test('a recorder that cannot be stopped ends the check', async () => {
  const stuck = checkCase('cpu.idle', async () => {
    throw new RecorderStuck('could not stop');
  }).then(
    () => 'went on',
    (error: unknown) => (error instanceof RecorderStuck ? 'ended' : 'other'),
  );
  expect(await stuck).toBe('ended');
});
