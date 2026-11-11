// Fails when a tracked file or a commit message contains a term this repo must not name: apps and
// organisations it was tried on stay private. Terms are stored as sha256 prefixes, so this file names
// nothing either. Run: `bun scripts/check-terms.ts` (CI and the pre-push hook do).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BLOCKED: [length: number, sha256: string][] = [
  [5, '67cc8f01181c3f4e'],
  [9, 'eda4068228fc64d1'],
  [7, 'eaa2bded32cc585d'],
  [12, '5904d3977a5538b0'],
  [9, '7c83afc63a3cb8fa'],
];

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The first blocked term inside `text` (anywhere in a word: "foobar" holds "bar"), or undefined. */
export function blockedTerm(text: string): string | undefined {
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    for (const [length, digest] of BLOCKED)
      for (let at = 0; at + length <= word.length; at++) {
        const part = word.slice(at, at + length);
        if (hash(part) === digest) return part;
      }
  return undefined;
}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

function main(): void {
  const problems: string[] = [];
  for (const file of git('ls-files', '-z').split('\0').filter(Boolean)) {
    const bytes = readFileSync(file);
    if (bytes.includes(0)) continue;
    const term = blockedTerm(`${file}\n${bytes.toString('utf8')}`);
    if (term) problems.push(`${file}: names a blocked term`);
  }
  for (const entry of git('log', '--all', '--format=%H%x00%B%x00').split('\0\n')) {
    const [sha, message] = entry.split('\0');
    if (sha && message && blockedTerm(message))
      problems.push(`commit ${sha.slice(0, 9)}: its message names a blocked term`);
  }
  for (const ref of git('for-each-ref', '--format=%(refname)').split('\n'))
    if (blockedTerm(ref)) problems.push(`${ref}: names a blocked term`);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
}

if (import.meta.main) main();
