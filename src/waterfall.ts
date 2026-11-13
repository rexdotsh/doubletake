import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Comparison } from './stats.ts';
import type { Experiment } from './store.ts';
import { change, value, verdict } from './report.ts';
import { type Waterfall, phaseMetric, waterfall } from './timeline.ts';
import { isRecord } from './util.ts';

// Launch timelines from an experiment's runs: each measured launch's marks, the median waterfall per side,
// and, for an A/B, the experiment's own comparison of each phase. Text for the terminal, SVG for a page.

/** One launch: each mark's time after the launch, ms. */
type Launch = Record<string, number>;

type Side = { role: 'base' | 'head'; label: string; launches: Launch[]; waterfall: Waterfall };
export type CaseTimeline = {
  case: string;
  sides: Side[];
  /** The experiment's comparisons of this case's phases and marks (A/B only). */
  comparisons: Comparison[];
  /** Declared marks no measured launch wrote, with the reason. */
  refused: Record<string, string>;
};

/** The measured launches of each case and side, from runs.ndjson: warm-up runs and blocks left out. */
export async function readLaunches(dir: string): Promise<Map<string, Map<'base' | 'head', Launch[]>>> {
  const text = await readFile(join(dir, 'runs.ndjson'), 'utf8').catch(() => '');
  const cases = new Map<string, Map<'base' | 'head', Launch[]>>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const run: unknown = JSON.parse(line);
    if (!isRecord(run) || run.warmup === true || run.block === 'warm' || !isRecord(run.values)) continue;
    if (typeof run.case !== 'string' || (run.role !== 'base' && run.role !== 'head')) continue;
    const marks: Launch = {};
    for (const [metric, v] of Object.entries(run.values))
      if (metric.startsWith('mark.') && typeof v === 'number') marks[metric.slice('mark.'.length)] = v;
    if (!Object.keys(marks).length) continue;
    const sides = cases.get(run.case) ?? new Map<'base' | 'head', Launch[]>();
    sides.set(run.role, [...(sides.get(run.role) ?? []), marks]);
    cases.set(run.case, sides);
  }
  return cases;
}

const timed = (m: string) => m.startsWith('phase.') || m.startsWith('mark.');

export function timelines(e: Experiment, launches: Map<string, Map<'base' | 'head', Launch[]>>): CaseTimeline[] {
  return [...launches].map(([name, bySide]) => {
    const series = e.series.find((s) => s.case === name);
    const check = e.checks.find((c) => c.case === name);
    const refused = Object.fromEntries(
      Object.entries(series?.refused ?? check?.refused ?? {}).filter(([m]) => m.startsWith('mark.')),
    );
    return {
      case: name,
      sides: (['base', 'head'] as const).flatMap((role) => {
        const list = bySide.get(role);
        if (!list) return [];
        const label = e.variants.find((v) => v.role === role)?.label ?? role;
        return [{ role, label, launches: list, waterfall: waterfall(list) }];
      }),
      comparisons: series ? [series.primary, ...series.secondaries].filter((c) => timed(c.metric)) : [],
      refused,
    };
  });
}

const n0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—');

/** Phases in one order for every side: the first side's, then any only another side has. */
function phaseRows(t: CaseTimeline): { from: string; to: string }[] {
  const rows = new Map<string, { from: string; to: string }>();
  for (const s of t.sides) for (const p of s.waterfall.phases) rows.set(phaseMetric(p.from, p.to), p);
  return [...rows.values()];
}

const total = (w: Waterfall) => w.marks.at(-1)?.at ?? 0;

function bar(start: number, ms: number, scale: number, width: number): string {
  const from = Math.round(start * scale);
  const len = Math.max(1, Math.round(Math.max(0, ms) * scale));
  return `${' '.repeat(Math.min(from, width))}${'█'.repeat(Math.min(len, width - Math.min(from, width) + 1))}`;
}

export function timelineText(t: CaseTimeline, platform: string): string {
  const origin = platform === 'ios' ? "the process's exec" : 'the launch intent';
  const lines = [`${t.case}: launch timeline (ms after ${origin})`, ''];
  for (const s of t.sides) {
    const names = s.waterfall.marks.map((m) => m.name);
    const widths = names.map((n) => Math.max(n.length, 6));
    lines.push(`${s.label} · ${s.launches.length} launches`);
    lines.push(`  ${'launch'.padEnd(7)}${names.map((n, i) => n.padStart((widths[i] ?? 6) + 2)).join('')}`);
    const row = (label: string, at: (name: string) => number | undefined) =>
      `  ${label.padEnd(7)}${names.map((n, i) => n0(at(n) ?? Number.NaN).padStart((widths[i] ?? 6) + 2)).join('')}`;
    s.launches.forEach((l, i) => lines.push(row(String(i + 1), (n) => l[n])));
    lines.push(row('median', (n) => s.waterfall.marks.find((m) => m.name === n)?.at));
    for (const m of s.waterfall.marks)
      if (m.n < s.launches.length)
        lines.push(`  missing: ${m.name} in ${s.launches.length - m.n} of ${s.launches.length} launches`);
    lines.push('');
  }
  const longest = Math.max(1, ...t.sides.map((s) => total(s.waterfall)));
  const scale = 40 / longest;
  const rows = phaseRows(t);
  const label = Math.max(20, ...rows.map((r) => `${r.from} → ${r.to}`.length));
  for (const s of t.sides) {
    lines.push(`${s.label}: median waterfall, ${n0(total(s.waterfall))} ms to the last mark`);
    lines.push(`  ${'phase'.padEnd(label)}  ${'at'.padStart(6)}  ${'ms'.padStart(6)}  n`);
    for (const r of rows) {
      const p = s.waterfall.phases.find((x) => x.from === r.from && x.to === r.to);
      const name = `${r.from} → ${r.to}`.padEnd(label);
      lines.push(
        p
          ? `  ${name}  ${n0(p.start).padStart(6)}  ${n0(p.ms).padStart(6)}  ${String(p.n).padEnd(3)} ${bar(p.start, p.ms, scale, 40)}`
          : `  ${name}  ${'—'.padStart(6)}  ${'—'.padStart(6)}  (not a phase on this side)`,
      );
    }
    lines.push('');
  }
  if (t.comparisons.length) {
    const [base, head] = t.sides.map((s) => s.label);
    const width = Math.max(...t.comparisons.map((c) => c.metric.length));
    lines.push(`${base ?? 'base'} → ${head ?? 'head'}, from the experiment's pairs:`);
    for (const c of t.comparisons)
      lines.push(
        `  ${c.metric.padEnd(width)}  ${value(c.metric, c.base).padStart(9)} → ${value(c.metric, c.head).padEnd(9)}  ${change(c).padEnd(30)} ${verdict(c)}`,
      );
    lines.push('');
  }
  for (const [m, why] of Object.entries(t.refused)) lines.push(`${m}: refused: ${why}`);
  return lines.join('\n').trimEnd();
}

const COLORS = [
  '#4e79a7',
  '#f28e2b',
  '#59a14f',
  '#e15759',
  '#76b7b2',
  '#edc948',
  '#b07aa1',
  '#ff9da7',
  '#9c755f',
  '#bab0ac',
  '#1f3b73',
  '#8cd17d',
];
const SIDE_COLORS = { base: '#8c8c8c', head: '#2f6fd6' } as const;
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function ticks(max: number): number[] {
  const step = [100, 200, 250, 500, 1000, 2000, 5000, 10_000].find((s) => max / s <= 10) ?? 20_000;
  return Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
}

/** The median waterfall of each side, one bar per phase, then every launch as one strip of its phases. */
export function timelineSvg(t: CaseTimeline): string {
  const left = 300;
  const chart = 600;
  const width = left + chart + 80;
  const longest = Math.max(1, ...t.sides.flatMap((s) => s.launches.map((l) => Math.max(0, ...Object.values(l)))));
  const x = (ms: number) => left + (Math.max(0, ms) / longest) * chart;
  const rows = phaseRows(t);
  const colorOf = new Map(rows.map((r, i) => [r.to, COLORS[i % COLORS.length] ?? '#999']));
  const out: string[] = [];
  let y = 30;
  out.push(`<text x="10" y="${y}" font-size="16" font-weight="bold">${esc(t.case)}: launch timeline</text>`);
  y += 20;
  t.sides.forEach((s, i) =>
    out.push(
      `<rect x="${10 + i * 200}" y="${y - 10}" width="12" height="12" fill="${SIDE_COLORS[s.role]}"/>`,
      `<text x="${28 + i * 200}" y="${y}">${esc(s.label)} (median of ${s.launches.length})</text>`,
    ),
  );
  y += 20;
  const top = y;
  for (const r of rows) {
    // The swatch is the phase's colour in the launch strips below.
    out.push(
      `<rect x="10" y="${y + 6 * t.sides.length - 6}" width="10" height="10" fill="${colorOf.get(r.to) ?? '#bbb'}"/>`,
      `<text x="26" y="${y + 6 * t.sides.length + 4}">${esc(`${r.from} → ${r.to}`)}</text>`,
    );
    for (const s of t.sides) {
      const p = s.waterfall.phases.find((q) => q.from === r.from && q.to === r.to);
      if (p) {
        const w = Math.max(1, x(p.start + p.ms) - x(p.start));
        out.push(
          `<rect x="${x(p.start).toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="10" fill="${SIDE_COLORS[s.role]}"/>`,
          `<text x="${(x(p.start) + w + 4).toFixed(1)}" y="${y + 9}" font-size="10">${n0(p.ms)} ms</text>`,
        );
      }
      y += 12;
    }
    y += 8;
  }
  y += 10;
  out.push(`<text x="10" y="${y}" font-weight="bold">every launch</text>`);
  y += 10;
  for (const s of t.sides)
    s.launches.forEach((l, i) => {
      out.push(`<text x="10" y="${y + 9}" font-size="10">${esc(s.label)} ${i + 1}</text>`);
      let from = 0;
      for (const [name, at] of Object.entries(l).toSorted((a, b) => a[1] - b[1])) {
        out.push(
          `<rect x="${x(from).toFixed(1)}" y="${y}" width="${Math.max(0.5, x(at) - x(from)).toFixed(1)}" height="10" fill="${colorOf.get(name) ?? '#bbb'}"><title>${esc(name)} ${n0(at)} ms</title></rect>`,
        );
        from = at;
      }
      y += 13;
    });
  y += 8;
  for (const tick of ticks(longest))
    out.push(
      `<line x1="${x(tick)}" y1="${top - 6}" x2="${x(tick)}" y2="${y}" stroke="#ddd"/>`,
      `<text x="${x(tick)}" y="${y + 14}" font-size="10" text-anchor="middle">${n0(tick)}</text>`,
    );
  out.push(`<text x="${left + chart}" y="${y + 30}" font-size="10" text-anchor="end">ms after the launch</text>`);
  y += 40;
  // Grid lines first, so bars draw over them.
  const grid = out.filter((s) => s.startsWith('<line'));
  const rest = out.filter((s) => !s.startsWith('<line'));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y}" font-family="system-ui, sans-serif" font-size="12">`,
    `<rect width="100%" height="100%" fill="white"/>`,
    ...grid,
    ...rest,
    '</svg>',
  ].join('\n');
}
