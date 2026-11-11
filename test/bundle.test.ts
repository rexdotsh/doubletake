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
  const refused = await readBundle(join(dir, 'bad.js'), join(dir, 'ok.js.map')).then(
    () => '',
    (error: unknown) => String(error),
  );
  expect(refused).toMatch(/2 modules but 1/);
  rmSync(dir, { recursive: true, force: true });
});

const section = (line: number, source: string, mappings: string) => ({
  offset: { line, column: 0 },
  map: { version: 3, sources: [source], mappings },
});

test('a mapping-less section (a JSON module) is named by its one source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doubletake-'));
  writeFileSync(join(dir, 'b.js'), '__d(function(){},0,[]);\n__d(function(){},1,[]);\n');
  writeFileSync(
    join(dir, 'b.js.map'),
    JSON.stringify({
      version: 3,
      sections: [section(0, 'node_modules/a/i.js', 'AAAA'), section(1, 'locales/en/common.json', '')],
    }),
  );
  const stats = await readBundle(join(dir, 'b.js'), join(dir, 'b.js.map'));
  expect(stats.modules.map((m) => m.source)).toEqual(['node_modules/a/i.js', 'locales/en/common.json']);
  rmSync(dir, { recursive: true, force: true });
});
