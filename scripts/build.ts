import { $ } from 'bun';
import { chmod, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
const cli = await Bun.build({
  entrypoints: ['src/cli.ts'],
  target: 'node',
  format: 'esm',
  naming: 'doubletake.mjs',
  outdir: 'dist',
  banner: '#!/usr/bin/env node',
});
if (!cli.success) throw new AggregateError(cli.logs, 'cli build failed');
await chmod('dist/doubletake.mjs', 0o755);
const sdk = await Bun.build({
  entrypoints: ['sdk/index.ts', 'sdk/marks.ts'],
  target: 'browser',
  format: 'esm',
  outdir: 'dist/sdk',
});
if (!sdk.success) throw new AggregateError(sdk.logs, 'sdk build failed');
await $`tsc -p sdk/tsconfig.build.json`;
