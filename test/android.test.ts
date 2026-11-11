import { expect, test } from 'bun:test';
import { parseAmStart, parseGfxinfo, parseMeminfo } from '../src/android.ts';

test('am start -W', () => {
  const out =
    'Starting: Intent { cmp=dev.x/.MainActivity }\nStatus: ok\nLaunchState: COLD\nActivity: dev.x/.MainActivity\nTotalTime: 812\nWaitTime: 815\nComplete\n';
  expect(parseAmStart(out)).toEqual({ totalTime: 812, launchState: 'COLD' });
});

test('gfxinfo', () => {
  const out =
    'Stats since: 123ns\nTotal frames rendered: 240\nJanky frames: 31 (12.92%)\n50th percentile: 9ms\n90th percentile: 21ms\n95th percentile: 27ms\n';
  expect(parseGfxinfo(out)).toEqual({ total: 240, janky: 31, p90: 21 });
});

test('meminfo totals', () => {
  const out = '            TOTAL PSS:   153600            TOTAL RSS:   256000       TOTAL SWAP PSS:       12\n';
  expect(parseMeminfo(out)).toEqual({ pss: 150, rss: 250 });
});
