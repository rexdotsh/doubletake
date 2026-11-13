import pkg from '../package.json' with { type: 'json' };
import { metricInfo, words } from './metrics.ts';
import type { Comparison } from './stats.ts';
import type { Experiment, Series } from './store.ts';

const MINUS = '\u2212';

/** `1 measured run`, `3 measured runs`. */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

function signed(shown: string, x: number): string {
  return x < 0 ? `${MINUS}${shown.replace('-', '')}` : x > 0 ? `+${shown}` : shown;
}

function value(metric: string, v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  const unit = metricInfo(metric)?.unit;
  if (unit === 'bytes') return v >= 2 ** 20 ? `${(v / 2 ** 20).toFixed(2)} MiB` : `${(v / 1024).toFixed(1)} KiB`;
  if (unit === 'count') return Number.isInteger(v) ? String(v) : v.toFixed(1);
  const digits = Math.abs(v) >= 100 ? 0 : 1;
  return `${v.toFixed(digits)}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`;
}

/** The change and its interval, with as many decimals as the interval's width needs. */
function change(c: Comparison): string {
  if (c.exact)
    return `${c.relative ? signed(`${(c.estimate * 100).toFixed(1)}%`, c.estimate) : signed(value(c.metric, Math.abs(c.estimate)), c.estimate)} (exact)`;
  if (Number.isNaN(c.lo)) return '—';
  if (c.relative) {
    const width = Math.abs(c.hi - c.lo) * 100;
    const digits = width >= 10 ? 0 : width >= 1 ? 1 : 2;
    const p = (x: number) => signed(`${Math.abs(x * 100).toFixed(digits)}%`, x);
    return `${p(c.estimate)} [${p(c.lo)} … ${p(c.hi)}]`;
  }
  const a = (x: number) => signed(value(c.metric, Math.abs(x)), x);
  return `${a(c.estimate)} [${a(c.lo)} … ${a(c.hi)}]`;
}

function verdict(c: Comparison): string {
  const [better, worse] = words(c.metric);
  const boundText = c.relative ? `±${(c.bound * 100).toFixed(1).replace(/\.0$/, '')}%` : `±${value(c.metric, c.bound)}`;
  switch (c.verdict_kind) {
    case 'better':
      return c.exact ? `${better} (exact)` : better;
    case 'worse':
      return c.exact ? `${worse} (exact)` : worse;
    case 'same':
      return c.exact ? 'same (exact)' : `same (${boundText})`;
    case 'unclear':
      return 'unclear';
    case 'underpowered':
      return c.needed_pairs ? `underpowered (~${c.needed_pairs} pairs needed)` : 'underpowered';
    case 'untested':
      return '·';
    default:
      return c.verdict_kind;
  }
}

function sideLabels(e: Experiment): [string, string] {
  const [base, head] = [e.variants.find((v) => v.role === 'base'), e.variants.find((v) => v.role === 'head')];
  return [base?.label ?? 'base', head?.label ?? 'head'];
}

function deviceLine(e: Experiment): string {
  const kind = e.device.platform === 'ios' ? 'Simulator' : 'Android';
  return `${e.device.name}, ${kind} ${e.device.os}${e.device.host ? ` on ${e.device.host}` : ''}`;
}

export function summary(e: Experiment): string {
  const [base, head] = sideLabels(e);
  const sides = e.kind === 'check' ? head : `${base} → ${head}`;
  const lines = [`doubletake ${e.id} · ${deviceLine(e)} · ${sides}`, ''];
  for (const s of e.series) {
    lines.push(
      `${s.case}  ★ ${s.primary.metric}  ${change(s.primary)}  ${verdict(s.primary)}  (${s.pairs} pairs, ${s.stopped})`,
    );
    lines.push(
      `    ${base} ${value(s.primary.metric, s.primary.base)} · ${head} ${value(s.primary.metric, s.primary.head)}`,
    );
    for (const c of s.secondaries)
      lines.push(
        `    ${c.metric.padEnd(18)} ${value(c.metric, c.base).padStart(10)} → ${value(c.metric, c.head).padEnd(10)} ${change(c).padEnd(30)} ${verdict(c)}`,
      );
    for (const [m, why] of Object.entries(s.refused))
      if (declared(s).includes(m)) lines.push(`    ${m.padEnd(18)} refused: ${why}`);
    lines.push('');
  }
  for (const r of e.refused_cases ?? []) lines.push(`${r.case}  refused (${r.validator}): ${r.message}`, '');
  for (const w of e.warnings) lines.push(`! ${w}`);
  for (const c of e.checks) {
    lines.push(`${c.case} (check, one run)`);
    for (const [m, v] of Object.entries(c.values)) lines.push(`    ${m.padEnd(18)} ${value(m, v)}`);
    for (const [m, why] of Object.entries(c.refused)) lines.push(`    ${m.padEnd(18)} refused: ${why}`);
  }
  return lines.join('\n');
}

const declared = (s: Series) => s.declared ?? [s.primary.metric];

function headline(s: Series): string {
  const c = s.primary;
  const [better, worse] = words(c.metric);
  const pctText = c.relative
    ? `${Math.abs(c.estimate * 100).toFixed(Math.abs(c.estimate) < 0.1 ? 1 : 0)}%`
    : value(c.metric, Math.abs(c.estimate));
  if (c.verdict_kind === 'better') return `${pctText} ${better}`;
  if (c.verdict_kind === 'worse') return `${pctText} ${worse}`;
  return verdict(c);
}

function row(s: Series, c: Comparison, primary: boolean): string {
  const name = primary ? `★ ${c.metric}` : c.metric;
  const v = primary ? `**${verdict(c)}**` : verdict(c);
  return `| ${primary ? s.case : ''} | ${name} | ${value(c.metric, c.base)} | ${value(c.metric, c.head)} | ${change(c)} | ${v} |`;
}

/** The markdown PR card: a table per experiment, the method folded away, delimited so it can be replaced. */
export function card(e: Experiment): string {
  if (e.kind === 'check')
    return [
      `<!-- doubletake:${e.id} begin -->`,
      `### doubletake check (one run per case, no verdict): ${sideLabels(e)[1]}`,
      '',
      '```',
      summary(e),
      '```',
      `<!-- doubletake:${e.id} end -->`,
    ].join('\n');
  const [base, head] = sideLabels(e);
  const lead = [
    ...e.series.map((s) => `**${s.case}**: ${headline(s)} (${s.primary.metric})`),
    ...(e.refused_cases ?? []).map((r) => `**${r.case}**: refused (${r.validator})`),
  ].join(' · ');
  const refused = e.series.flatMap((s) =>
    Object.entries(s.refused)
      .filter(([m]) => declared(s).includes(m))
      .map(([m, why]) => `\`${m}\` (${why.split(':')[0]})`),
  );
  const plan = e.plan;
  const lines = [
    `<!-- doubletake:${e.id} begin -->`,
    `### doubletake: ${head} vs ${base}`,
    '',
    lead,
    '',
    `| Case | Metric | ${base} | ${head} | Change | Verdict |`,
    '|---|---|--:|--:|---|---|',
    ...e.series.flatMap((s) => [
      row(s, s.primary, true),
      ...s.secondaries
        .filter((c) => c.verdict_kind !== 'untested' || isHeadline(c.metric))
        .map((c) => row(s, c, false)),
    ]),
    '',
    '<details><summary>Method</summary>',
    '',
    `- ${deviceLine(e)}; doubletake ${pkg.version}.`,
    `- ${e.series.map((s) => `${s.case}: ${s.pairs} pairs (${s.stopped})`).join('; ')}. Pairs alternate ${base}, ${head} then ${head}, ${base}, after one discarded warm-up block per side; ${count(plan.runs, 'measured run')} per block${plan.runs > 1 ? ' (median)' : ''}, ${plan.warmup_runs ? `${count(plan.warmup_runs, 'discarded run')} first` : 'no discarded run'}; ${plan.install} installs.`,
    `- Change: mean of the paired log ratios (or differences), with a bootstrap interval (10,000 resamples, expanded percentile) at ${plan.pairs === 'auto' ? '98.42% at each planned look (8, 12, 18, 26, 40 pairs)' : '95%'} for the primary; a direction also needs the signed-rank test to agree.`,
    '- ★ is the primary, declared before the run. Declared secondaries get words only after it decided, at a Bonferroni level (95% across them); `·` is descriptive (95%).',
    ...(refused.length ? [`- Not measured: ${refused.join(', ')}.`] : []),
    ...(e.refused_cases ?? []).map((r) => `- ${r.case} refused (${r.validator}): ${r.message}.`),
    ...e.warnings.map((w) => `- Warning: ${w}.`),
    '',
    '</details>',
    `<!-- doubletake:${e.id} end -->`,
  ];
  return lines.join('\n');
}

function isHeadline(metric: string): boolean {
  return [
    'cpu.time',
    'memory.peak',
    'js.stall',
    'net.requests',
    'launch.ttid',
    'launch.visual',
    'frames.janky',
  ].includes(metric);
}
