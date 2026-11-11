import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duplicates, firstSources, packageOf, readBundle } from '../src/bundle.ts';

test('the first source of each generated line, with deltas carried across lines', () => {
  // line 0: source 0; line 1: none; line 2: +2 then +1 (first is 2); line 3: −1 from 3 = 2
  expect(firstSources('AAAA;;AEAA,ACAA;ADAA')).toEqual([0, undefined, 2, 2]);
});

test('packages and pnpm versions from source paths', () => {
  expect(packageOf('../node_modules/.pnpm/viem@2.52.0_typescript@5/node_modules/viem/_cjs/index.js')).toEqual({
    pkg: 'viem',
    version: '2.52.0',
  });
  expect(
    packageOf('../node_modules/.pnpm/@noble+curves@1.9.1/node_modules/@noble/curves/esm/abstract/curve.js'),
  ).toEqual({ pkg: '@noble/curves', version: '1.9.1' });
  expect(packageOf('apps/mobile/src/home.tsx').pkg).toBe('(app) apps/mobile');
});

const mod = (pkg: string, version: string, bytes: number) => ({ id: 0, bytes, source: '', pkg, version });

test('a package at two versions is a duplicate', () => {
  const dups = duplicates({
    bytes: 0,
    modules: [mod('viem', '2.52.0', 10), mod('viem', '2.57.7', 20), mod('ox', '1.0.0', 5)],
  });
  expect(dups.map((d) => d.pkg)).toEqual(['viem']);
});

test('a module spanning lines keeps its lines; two modules on one line are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doubletake-'));
  const map = JSON.stringify({
    version: 3,
    sources: ['node_modules/a/index.js', 'node_modules/b/index.js'],
    mappings: 'AAAA;AAAA;ACAA;AAAA',
  });
  writeFileSync(join(dir, 'ok.js'), '__d(function(){\nreturn 1\n},0,[]);\n__d(function(){},1,[]);\n__r(0);\n');
  writeFileSync(join(dir, 'ok.js.map'), map);
  const stats = await readBundle(join(dir, 'ok.js'), join(dir, 'ok.js.map'));
  expect(stats.modules.map((m) => [m.pkg, m.bytes])).toEqual([
    ['a', 34],
    ['b', 24],
  ]);
  writeFileSync(join(dir, 'bad.js'), '__d(function(){},0,[]);__d(function(){},1,[]);\n');
  await expect(readBundle(join(dir, 'bad.js'), join(dir, 'ok.js.map'))).rejects.toThrow(/2 modules but 1/);
  rmSync(dir, { recursive: true, force: true });
});
