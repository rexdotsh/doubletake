import type { ProbeRequest } from '../sdk/probe.ts';
import type { ProbeDetail } from './probe.ts';
import type { Experiment } from './store.ts';

// The app probe's detail per case: re-rendering components, duplicate requests and a request waterfall, for one
// side (a check) or both (a bench, from each side's typical run). The counts' verdicts are the series' own rows.

const TOP = 8;
const BAR = 32;
const MINUS = '\u2212';

type Sides = { base?: ProbeDetail; head?: ProbeDetail };

function bytes(n: number): string {
  if (n >= 2 ** 20) return `${(n / 2 ** 20).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

const shown = (v: number | undefined, unit?: 'bytes') => (v === undefined ? '—' : unit ? bytes(v) : String(v));

function pair(base: number | undefined, head: number | undefined, unit?: 'bytes'): string {
  return base === undefined ? shown(head, unit) : `${shown(base, unit)} → ${shown(head, unit)}`;
}

function counts({ base, head }: Sides): string {
  const one = (label: string, pick: (d: ProbeDetail) => number | undefined, unit?: 'bytes') => {
    const b = base && pick(base);
    const h = head && pick(head);
    return b === undefined && h === undefined ? [] : [`${label} ${pair(b, h, unit)}`];
  };
  return [
    ...one('commits', (d) => d.commits),
    ...one('renders', (d) => d.renders),
    ...one('mounts', (d) => d.mounts),
    ...one('requests', (d) => d.requests),
    ...one('duplicates', (d) => d.duplicates),
    ...one('bytes', (d) => d.bytes, 'bytes'),
  ].join(' · ');
}

/** Components by re-renders (renders that were not mounts), most first. */
function rerendering(d: ProbeDetail): string[] {
  return (d.components ?? [])
    .map((c) => ({ name: c.name, mounts: c.mounts, updates: c.renders - c.mounts }))
    .filter((c) => c.updates > 0)
    .toSorted((a, b) => b.updates - a.updates)
    .slice(0, TOP)
    .map((c) => `${c.name} ${c.updates}${c.mounts ? ` (+${c.mounts} mounts)` : ''}`);
}

/** Components whose renders changed most between the sides. */
function changed(base: ProbeDetail, head: ProbeDetail): string[] {
  const names = new Map<string, [number, number]>();
  for (const c of base.components ?? []) names.set(c.name, [c.renders, 0]);
  for (const c of head.components ?? []) names.set(c.name, [names.get(c.name)?.[0] ?? 0, c.renders]);
  return [...names]
    .filter(([, [b, h]]) => b !== h)
    .toSorted(([, [b1, h1]], [, [b2, h2]]) => Math.abs(h2 - b2) - Math.abs(h1 - b1))
    .slice(0, TOP)
    .map(([name, [b, h]]) => `${name} ${b} → ${h} (${h > b ? '+' : MINUS}${Math.abs(h - b)})`);
}

function duplicates(d: ProbeDetail): string[] {
  return (d.keys ?? [])
    .filter((k) => k.count > 1)
    .map((k) => `${k.key} ×${k.count}${k.bytes ? ` (${bytes(k.bytes)})` : ''}`);
}

/** One line per request: a bar over the window, start, duration, status, size, method and URL. */
export function waterfall(requests: readonly ProbeRequest[], ms: number): string[] {
  const span = Math.max(ms, ...requests.map((r) => r.end ?? r.start), 1);
  const at = (t: number) => Math.min(BAR - 1, Math.floor((t / span) * BAR));
  return requests.map((r) => {
    const from = at(r.start);
    const to = r.end === undefined ? BAR - 1 : Math.max(from, at(r.end));
    const bar = `${' '.repeat(from)}${(r.end === undefined ? '…' : '█').repeat(to - from + 1)}`.padEnd(BAR);
    const took = r.end === undefined ? 'open' : `${Math.round(r.end - r.start)} ms`;
    const query = r.query ? `?#${r.query}` : '';
    return `▕${bar}▏ ${`+${Math.round(r.start)}`.padStart(6)} ${took.padStart(8)}  ${String(r.status || '—').padStart(3)} ${bytes(r.bytes).padStart(9)}  ${r.method} ${r.url}${query}`;
  });
}

function details({ base, head }: Sides, indent: string): string[] {
  const off = Math.max(base?.overrun ?? 0, head?.overrun ?? 0);
  const lines = [`${indent}${counts({ base, head }) || 'no counts (refused: see the metrics)'}`];
  if (off) lines.push(`${indent}the app counted a span ${off} ms off the measured window`);
  const sides: [string, ProbeDetail][] =
    base && head
      ? [
          [' (head)', head],
          [' (base)', base],
        ]
      : [['', head ?? base]].filter((s): s is [string, ProbeDetail] => s[1] !== undefined);
  for (const [side, d] of sides) {
    const re = rerendering(d);
    if (re.length) lines.push(`${indent}re-rendering${side}: ${re.join(', ')}`);
    const dup = duplicates(d);
    if (dup.length) lines.push(`${indent}duplicate requests${side}: ${dup.join(', ')}`);
  }
  if (base && head) {
    const moved = changed(base, head);
    if (moved.length) lines.push(`${indent}renders changed: ${moved.join(', ')}`);
  }
  for (const [side, d] of sides) {
    if (!d.waterfall?.length) continue;
    lines.push(`${indent}requests${side}, ${(d.ms / 1000).toFixed(1)} s window:`);
    lines.push(...waterfall(d.waterfall, d.ms).map((l) => `${indent}  ${l}`));
  }
  return lines;
}

function cases(e: Experiment): [string, Sides][] {
  return [
    ...e.series.flatMap((s): [string, Sides][] => (s.probe ? [[s.case, s.probe]] : [])),
    ...e.checks.flatMap((c): [string, Sides][] => (c.probe ? [[c.case, { head: c.probe }]] : [])),
  ];
}

/** The terminal section, after the verdicts; empty when no case read the probe. */
export function probeText(e: Experiment): string[] {
  const all = cases(e);
  if (!all.length) return [];
  const lines = ['', 'renders and requests (app probe, typical run per side)'];
  for (const [name, sides] of all) lines.push(`  ${name}`, ...details(sides, '    '));
  return lines;
}

/** The card's folded section. */
export function probeCard(e: Experiment): string[] {
  const all = cases(e);
  if (!all.length) return [];
  return [
    '<details><summary>Renders and requests (app probe)</summary>',
    '',
    '| Case | Commits | Renders | Requests | Duplicates | Bytes |',
    '|---|--:|--:|--:|--:|--:|',
    ...all.map(([name, { base, head }]) => {
      const cell = (pick: (d: ProbeDetail) => number | undefined, unit?: 'bytes') =>
        pair(base && pick(base), head && pick(head), unit);
      return `| ${name} | ${cell((d) => d.commits)} | ${cell((d) => d.renders)} | ${cell((d) => d.requests)} | ${cell((d) => d.duplicates)} | ${cell((d) => d.bytes, 'bytes')} |`;
    }),
    '',
    '```',
    ...all.flatMap(([name, sides]) => {
      const lines = details(sides, '  ');
      lines[0] = name;
      return lines;
    }),
    '```',
    '',
    '</details>',
    '',
  ];
}
