import type { Experiment } from '../store.ts';
import { type Change, type DiffRow, called } from './diff.ts';
import type { Cost } from './model.ts';
import type { ProfileResult, ProfileSide } from './result.ts';

const MINUS = '\u2212';

const ms = (x: number) => `${x >= 100 ? x.toFixed(0) : x.toFixed(1)} ms`;
const signed = (x: number) => `${x < 0 ? MINUS : '+'}${ms(Math.abs(x))}`;
const pct = (x: number, of: number) => `${of > 0 ? ((100 * x) / of).toFixed(1) : '0.0'}%`;

/** `fn  (file:line)` for JS, `fn  (lib)` for native. */
function where(c: Pick<Cost, 'name' | 'module' | 'file'>): string {
  return `${c.name}  (${c.file ?? c.module})`;
}

const changeText = (c: Change) =>
  `${ms(c.base)} → ${ms(c.head)}  ${signed(c.delta)} [${signed(c.lo)} … ${signed(c.hi)}]  ${c.call ?? '·'} (head higher in ${c.up}/${c.n} pairs)`;

function sideLines(r: ProfileResult, s: ProfileSide): string[] {
  const lines = [`  ${s.label} (${s.role}): ${ms(s.ms)} sampled per run, mean of ${s.runs} · flame graph ${s.flame}`];
  if (s.threads.length) lines.push(`    threads: ${s.threads.map((t) => `${t.name} ${ms(t.total)}`).join(', ')}`);
  lines.push('    self time:');
  for (const c of s.self.slice(0, 10))
    lines.push(`      ${ms(c.self).padStart(10)} ${pct(c.self, s.ms).padStart(6)}  ${where(c)}`);
  lines.push(`    total time${s.threads.length ? ' (without thread entries and kernel frames)' : ''}:`);
  for (const c of s.total.slice(0, 10))
    lines.push(`      ${ms(c.total).padStart(10)} ${pct(c.total, s.ms).padStart(6)}  ${where(c)}`);
  lines.push(`    ${r.kind === 'js' ? 'packages and app folders' : 'libraries'} (self · total):`);
  for (const m of s.modules.slice(0, 8))
    lines.push(`      ${ms(m.self).padStart(10)} · ${ms(m.total).padStart(10)}  ${m.name}`);
  return lines;
}

function rowLine(r: DiffRow): string {
  const c = r.total.call ? r.total : r.self;
  return `      ${r.total.call ? 'total' : 'self '} ${changeText(c)}  ${where(r)}`;
}

/** The profile section of the text report. */
export function profileText(e: Experiment): string[] {
  const lines: string[] = [];
  for (const r of e.profiles ?? []) {
    const runs = r.diff ? `${r.diff.pairs} profiled pairs` : `${r.sides[0]?.runs ?? 0} profiled run(s)`;
    lines.push(`${r.case}  profile: ${r.kind === 'js' ? 'JS' : 'native'} (${r.profiler}), ${runs}, never timed`);
    for (const s of r.sides) lines.push(...sideLines(r, s));
    if (r.diff) {
      lines.push(`  sampled time: ${changeText(r.diff.ms)}`);
      const moved = [...called(r.diff, 'functions'), ...called(r.diff, 'modules')];
      if (moved.length) lines.push('    moved (consistent across pairs):', ...moved.map(rowLine));
      else lines.push('    no function or module moved consistently across the pairs');
    }
    for (const n of r.notes) lines.push(`  note: ${n}`);
    lines.push('');
  }
  for (const x of e.profile_refusals ?? [])
    lines.push(
      `${x.case}  profile${x.kind ? ` (${x.kind === 'js' ? 'JS' : 'native'})` : ''}: not recorded: ${x.reason}`,
    );
  return lines;
}

const cell = (s: string) => s.replaceAll('|', '\\|');

/** The PR card's profile part: per case and kind, the functions and modules that moved, top 8. */
export function profileCard(e: Experiment): string[] {
  const results = (e.profiles ?? []).filter((r) => r.diff);
  if (!results.length) return [];
  const lines = ['', '<details><summary>Profiles (attribution, never timed)</summary>', ''];
  for (const r of results) {
    const d = r.diff;
    if (!d) continue;
    lines.push(
      `**${r.case}** · ${r.kind === 'js' ? 'JS' : 'native'} (${r.profiler}), ${d.pairs} pairs: sampled ${ms(d.ms.base)} → ${ms(d.ms.head)} (${signed(d.ms.delta)}, ${d.ms.call ?? 'no consistent change'})`,
      '',
    );
    const moved = [...called(d, 'functions'), ...called(d, 'modules')].slice(0, 8);
    if (!moved.length) {
      lines.push('No function or module moved consistently across the pairs.', '');
      continue;
    }
    lines.push('| | Function or module | Base | Head | Change |', '|---|---|--:|--:|---|');
    for (const row of moved) {
      const c = row.total.call ? row.total : row.self;
      lines.push(
        `| ${c.call === 'slower' ? '🔺' : '🔻'} ${row.total.call ? 'total' : 'self'} | ${cell(where(row))} | ${ms(c.base)} | ${ms(c.head)} | ${signed(c.delta)} (${c.up}/${c.n}) |`,
      );
    }
    lines.push('');
  }
  lines.push(
    'Medians over profiled pairs run after the timed ones; a row is listed when the bootstrap interval of its per-pair differences clears zero, the signed-rank test agrees (5%, uncorrected across rows: a lone row is a lead), and it moved ≥ 5 ms and ≥ 5%.',
    '',
    '</details>',
  );
  return lines;
}
