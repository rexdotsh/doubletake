import { expect, test } from 'bun:test';
import { run } from '../src/sh.ts';

test('a command that exits without reading its input does not crash the process', async () => {
  const result = await run('sh', ['-c', 'exit 3'], { check: false, input: 'x'.repeat(4_000_000) });
  expect(result.code).toBe(3);
});
