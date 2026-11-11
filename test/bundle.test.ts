import { expect, test } from 'bun:test';
import { duplicates, firstSources, packageOf } from '../src/bundle.ts';

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
