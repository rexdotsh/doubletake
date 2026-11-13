import { expect, test } from 'bun:test';
import { card, summary } from '../src/report.ts';
import type { Experiment } from '../src/store.ts';

const experiment: Experiment = {
  schema: 'doubletake.experiment.v1',
  id: 'exp_test',
  kind: 'experiment',
  created: '2026-01-01T00:00:00Z',
  file: 'app.bench.ts',
  comparison: 'builds',
  device: { platform: 'android', name: 'emulator', os: '16', id: 'emulator-5554', host: '' },
  variants: [],
  plan: { pairs: 8, runs: 1, warmup_runs: 1, warmup_blocks: 1, order: 'ABBA', install: 'sequential' },
  decided: false,
  series: [],
  checks: [],
  warnings: [],
  refused_cases: [{ case: 'idle', validator: 'Background', message: 'other processes used 6 of 10 cores' }],
};

test('a case refused as a whole is in the summary and the card', () => {
  expect(summary(experiment)).toContain('idle  refused (Background): other processes used 6 of 10 cores');
  expect(card(experiment)).toContain('**idle**: refused (Background)');
});
