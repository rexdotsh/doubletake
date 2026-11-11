import { readFile } from 'node:fs/promises';
import { dig } from './util.ts';

// Static analysis of a Metro bundle and its source map: bytes by package, packages bundled at two versions,
// and the difference between two bundles. Exact numbers, no runs: it says what ships, not how fast it runs.

type Module = { id: number; bytes: number; source: string; pkg: string; version: string };
export type BundleStats = { bytes: number; modules: Module[] };

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The source index of the first segment of each generated line (VLQ fields are deltas across the map). */
export function firstSources(mappings: string): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  let source = 0;
  for (const line of mappings.split(';')) {
    let first: number | undefined;
    for (const segment of line.split(',')) {
      if (!segment) continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of segment) {
        const digit = B64.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          fields.push(value & 1 ? -(value >> 1) : value >> 1);
          value = 0;
          shift = 0;
        }
      }
      if (fields.length >= 4) {
        source += fields[1] ?? 0;
        first ??= source;
      }
    }
    out.push(first);
  }
  return out;
}

/** The package a source path belongs to, with its version when pnpm's store path says it. */
export function packageOf(source: string): { pkg: string; version: string } {
  const at = source.lastIndexOf('node_modules/');
  if (at < 0)
    return {
      pkg: `(app) ${source
        .replace(/^(\.\.\/|\/)+/, '')
        .split('/')
        .slice(0, 2)
        .join('/')}`,
      version: '',
    };
  const parts = source.slice(at + 13).split('/');
  const pkg = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : (parts[0] ?? '?');
  const store = /\.pnpm\/((?:@[^+/]+\+)?[^@/]+)@([^_/]+)/.exec(source.slice(0, at));
  return { pkg, version: store?.[2] ?? '' };
}

/** The source of each generated line, from a plain map or an indexed one (Metro and Expo write sections). */
function lineSourcesOf(map: unknown, file: string): (string | undefined)[] {
  const sections = dig(map, 'sections');
  if (Array.isArray(sections)) {
    const out: (string | undefined)[] = [];
    for (const section of sections) {
      const line = dig(section, 'offset', 'line');
      const lines = lineSourcesOf(dig(section, 'map'), file);
      if (typeof line !== 'number') continue;
      lines.forEach((source, i) => (out[line + i] ??= source));
      // A section with one source and no mappings (Metro's JSON and asset modules) still names its module.
      const sources = dig(section, 'map', 'sources');
      if (Array.isArray(sources) && sources.length === 1) out[line] ??= String(sources[0]);
    }
    return out;
  }
  const sources = dig(map, 'sources');
  const mappings = dig(map, 'mappings');
  if (!Array.isArray(sources) || typeof mappings !== 'string')
    throw new Error(`${file}: not a source map (sources and mappings, or sections)`);
  return firstSources(mappings).map((i) => (i === undefined ? undefined : String(sources[i])));
}

export async function readBundle(bundleFile: string, mapFile: string): Promise<BundleStats> {
  const [code, mapText] = await Promise.all([readFile(bundleFile, 'utf8'), readFile(mapFile, 'utf8')]);
  const lineSources = lineSourcesOf(JSON.parse(mapText), mapFile);
  const modules: Module[] = [];
  const lines = code.split('\n');
  // Metro writes one module per line, from column 0; a module spanning lines keeps the lines after it until
  // the next module or require. Two modules on one line would be misattributed, so refuse that layout.
  const defined = (code.match(/__d\(/g) ?? []).length;
  let current: Module | undefined;
  lines.forEach((line, i) => {
    if (line.startsWith('__d(')) {
      const id = Number(/,(\d+),\[[\d,]*\](?:,"[^"]*")?\);?\s*$/.exec(line)?.[1] ?? Number.NaN);
      const source = lineSources[i] ?? '(no source map)';
      current = { id, bytes: 0, source, ...packageOf(source) };
      modules.push(current);
    } else if (line.startsWith('__r(')) current = undefined;
    if (current) current.bytes += Buffer.byteLength(line) + 1;
  });
  groupAppCode(modules);
  if (defined !== modules.length)
    throw new Error(
      `${bundleFile}: ${defined} modules but ${modules.length} start a line: not a layout doubletake can attribute`,
    );
  return { bytes: Buffer.byteLength(code), modules };
}

/**
 * App code (outside node_modules) is grouped by its first folder below the app's root: the two-folder prefix
 * holding the most app bytes (a monorepo's `apps/mobile`). Other app sources keep their two-folder prefix.
 */
function groupAppCode(modules: Module[]): void {
  const app = modules.filter((m) => !m.source.includes('node_modules/') && m.source.includes('/'));
  const parts = (m: Module) => m.source.replace(/^(\.\.\/|\/)+/, '').split('/');
  const weight = new Map<string, number>();
  for (const m of app) {
    const root = parts(m).slice(0, 2).join('/');
    weight.set(root, (weight.get(root) ?? 0) + m.bytes);
  }
  const [root] = [...weight].toSorted((x, y) => y[1] - x[1])[0] ?? [''];
  for (const m of app) {
    const p = parts(m);
    m.pkg = `(app) ${p.slice(0, 2).join('/') === root && p.length > 3 ? p[2] : p.slice(0, 2).join('/')}`;
  }
}

function byPackage(stats: BundleStats): Map<string, number> {
  const totals = new Map<string, number>();
  for (const m of stats.modules) totals.set(m.pkg, (totals.get(m.pkg) ?? 0) + m.bytes);
  return totals;
}

/** Packages bundled at more than one version, with the bytes of each. */
export function duplicates(stats: BundleStats): { pkg: string; versions: Map<string, number> }[] {
  const seen = new Map<string, Map<string, number>>();
  for (const m of stats.modules) {
    if (!m.version) continue;
    const versions = seen.get(m.pkg) ?? new Map<string, number>();
    versions.set(m.version, (versions.get(m.version) ?? 0) + m.bytes);
    seen.set(m.pkg, versions);
  }
  return [...seen].filter(([, v]) => v.size > 1).map(([pkg, versions]) => ({ pkg, versions }));
}

const kib = (b: number) => `${(b / 1024).toFixed(0)} KiB`;
const signedKib = (b: number) => `${b > 0 ? '+' : b < 0 ? '\u2212' : ''}${(Math.abs(b) / 1024).toFixed(0)} KiB`;

export function bundleReport(head: BundleStats, base?: BundleStats, top = 15): string {
  const lines: string[] = [];
  const headPkgs = byPackage(head);
  if (!base) {
    lines.push(`bundle ${kib(head.bytes)}, ${head.modules.length} modules`);
    for (const [pkg, bytes] of [...headPkgs].toSorted((a, b) => b[1] - a[1]).slice(0, top))
      lines.push(`  ${kib(bytes).padStart(9)}  ${((100 * bytes) / head.bytes).toFixed(1).padStart(5)}%  ${pkg}`);
  } else {
    const basePkgs = byPackage(base);
    lines.push(
      `bundle ${kib(base.bytes)} → ${kib(head.bytes)} (${signedKib(head.bytes - base.bytes)}, exact), modules ${base.modules.length} → ${head.modules.length}`,
    );
    const names = new Set([...basePkgs.keys(), ...headPkgs.keys()]);
    const deltas = [...names]
      .map((pkg) => ({ pkg, delta: (headPkgs.get(pkg) ?? 0) - (basePkgs.get(pkg) ?? 0) }))
      .filter((d) => d.delta !== 0);
    for (const d of deltas.toSorted((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, top))
      lines.push(`  ${signedKib(d.delta).padStart(10)}  ${d.pkg}`);
  }
  const dups = duplicates(head);
  if (dups.length) {
    lines.push('packages at more than one version:');
    for (const d of dups
      .toSorted(
        (a, b) =>
          [...b.versions.values()].reduce((s, v) => s + v, 0) - [...a.versions.values()].reduce((s, v) => s + v, 0),
      )
      .slice(0, top))
      lines.push(`  ${d.pkg}: ${[...d.versions].map(([v, b]) => `${v} ${kib(b)}`).join(', ')}`);
  }
  return lines.join('\n');
}
