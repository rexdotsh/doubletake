import { expect, test } from 'bun:test';
import { blockedTerm } from '../scripts/check-terms.ts';

test('ordinary text passes', () => {
  expect(blockedTerm('A production React Native app: Expo, Hermes, a 24 MB bundle, viem and ox.')).toBeUndefined();
});
