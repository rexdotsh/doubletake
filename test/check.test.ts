import { expect, test } from 'bun:test';
import { Refusal } from '../src/device.ts';
import { checkCase } from '../src/experiment.ts';

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
