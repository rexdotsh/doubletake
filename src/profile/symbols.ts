import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { type BundleStats, appRoot, groupAppCode, packageOf, vlq } from '../bundle.ts';
import { dig, isRecord } from '../util.ts';
import { type Frame, type Profile, mapFrames } from './model.ts';

// Symbolication: JS frames through the bundle's source map (Metro's, or Hermes's composed map whose one line is
// the bytecode), with function names from Metro's function maps (`x_facebook_sources`); Java and Kotlin frames
// through an R8 mapping file.

type Original = { source: string; line: number; column: number; name?: string };

type Lookup = (line: number, column: number) => Original | undefined;

/** A plain map's segments, decoded once; a lookup takes the last segment at or before the column on its line. */
function plain(map: Record<string, unknown>): { lookup: Lookup; sources: string[] } {
  const sources = Array.isArray(map.sources) ? map.sources.map(String) : [];
  const names = Array.isArray(map.names) ? map.names.map(String) : [];
  const mappings = typeof map.mappings === 'string' ? map.mappings : '';
  const functions = Array.isArray(map.x_facebook_sources) ? map.x_facebook_sources : [];
  const lines = mappings.split(';');
  const decoded: Int32Array[] = [];
  let [source, oLine, oColumn, name] = [0, 0, 0, 0];
  for (const line of lines) {
    const out: number[] = [];
    let column = 0;
    for (const segment of line.split(',')) {
      if (!segment) continue;
      const f = vlq(segment);
      column += f[0] ?? 0;
      if (f.length < 4) continue;
      source += f[1] ?? 0;
      oLine += f[2] ?? 0;
      oColumn += f[3] ?? 0;
      if (f.length >= 5) name += f[4] ?? 0;
      out.push(column, source, oLine, oColumn, f.length >= 5 ? name : -1);
    }
    decoded.push(Int32Array.from(out));
  }
  const fnMaps = new Map<number, { line: number; column: number; name: string }[]>();
  const enclosing = (src: number, line: number, column: number): string | undefined => {
    let list = fnMaps.get(src);
    if (!list) {
      list = decodeFunctionMap(dig(functions[src], 0));
      fnMaps.set(src, list);
    }
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = list[mid];
      if (m && (m.line < line || (m.line === line && m.column <= column))) lo = mid + 1;
      else hi = mid;
    }
    return list[lo - 1]?.name;
  };
  const lookup: Lookup = (line, column) => {
    const seg = decoded[line - 1];
    if (!seg?.length) return undefined;
    let lo = 0;
    let hi = seg.length / 5;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((seg[mid * 5] ?? 0) <= column) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return undefined;
    const at = (lo - 1) * 5;
    const [src, l, c, n] = [seg[at + 1] ?? 0, (seg[at + 2] ?? 0) + 1, seg[at + 3] ?? 0, seg[at + 4] ?? -1];
    const s = sources[src];
    if (s === undefined) return undefined;
    return { source: s, line: l, column: c, name: enclosing(src, l, c) ?? (n >= 0 ? names[n] : undefined) };
  };
  return { lookup, sources };
}

/** Metro's function map: per source, where each function starts (1-based line, 0-based column) and its name. */
function decodeFunctionMap(map: unknown): { line: number; column: number; name: string }[] {
  const names = dig(map, 'names');
  const mappings = dig(map, 'mappings');
  if (!Array.isArray(names) || typeof mappings !== 'string') return [];
  const out: { line: number; column: number; name: string }[] = [];
  let line = 1;
  let name = 0;
  for (const lineMappings of mappings.split(';')) {
    let column = 0;
    for (const segment of lineMappings.split(',')) {
      if (!segment) continue;
      const [dc = 0, dn = 0, dl = 0] = vlq(segment);
      line += dl;
      name += dn;
      column += dc;
      out.push({ line, column, name: String(names[name]) });
    }
  }
  return out;
}

export type SourceMap = { lookup: Lookup; sources: string[] };

/** A plain or indexed (sectioned) source map. */
export function sourceMap(json: unknown): SourceMap {
  if (!isRecord(json)) throw new Error('not a source map');
  if (!Array.isArray(json.sections)) {
    if (typeof json.mappings !== 'string') throw new Error('not a source map: no mappings or sections');
    return plain(json);
  }
  const sections = json.sections.flatMap((s: unknown) => {
    const line = dig(s, 'offset', 'line');
    const column = dig(s, 'offset', 'column');
    const map = dig(s, 'map');
    return typeof line === 'number' && typeof column === 'number' && isRecord(map)
      ? [{ line, column, ...plain(map) }]
      : [];
  });
  return {
    sources: sections.flatMap((s) => s.sources),
    lookup(line, column) {
      const s = sections.findLast((x) => x.line < line - 1 || (x.line === line - 1 && x.column <= column));
      if (!s) return undefined;
      return s.lookup(line - s.line, line - 1 === s.line ? column - s.column : column);
    },
  };
}

/** A source path as reports show it: from its package, or from the app's root folder. */
function shortPath(source: string): string {
  const at = source.lastIndexOf('node_modules/');
  return at >= 0 ? source.slice(at + 'node_modules/'.length) : source.replace(/^(\.\.\/|\/)+/, '');
}

/** Each source's module: its package, or `(app) <folder>` below the app's root, as `bundle` groups them. */
function modulesOf(sources: readonly string[]): Map<string, string> {
  const stats: BundleStats = {
    bytes: 0,
    modules: sources.map((source) => ({ id: 0, bytes: 1, source, ...packageOf(source) })),
  };
  groupAppCode(stats, appRoot(stats));
  return new Map(stats.modules.map((m) => [m.source, m.pkg]));
}

/** JS frames to their original function, file, line and module; frames the map does not cover stay as they were. */
export function symbolicate(p: Profile, map: SourceMap): Profile {
  const modules = modulesOf(map.sources);
  let missed = 0;
  const out = mapFrames(p, (f): Frame => {
    if (!f.at) return f;
    const o = map.lookup(f.at.line, f.at.column);
    if (!o) {
      missed++;
      return { name: f.name, module: f.module };
    }
    return {
      name: o.name ?? f.name,
      module: modules.get(o.source) ?? '(app)',
      file: shortPath(o.source),
      line: o.line,
    };
  });
  return missed ? { ...out, notes: [...out.notes, `${missed} frames not in the source map`] } : out;
}

/** An R8 / ProGuard mapping: obfuscated class to its original name and its methods' original names. */
export type R8 = Map<string, { name: string; methods: Map<string, Set<string>> }>;

/** A Java frame's symbol: an optional return type, the class, the method, optional arguments. */
const SYMBOL = /^(?:\S+ )?([\w$.]+)\.([\w$<>-]+)(\(.*\))?$/;

/** Reads mapping lines; with `wanted`, keeps only those obfuscated classes (an app's mapping runs to 300 MB). */
function r8Reader(wanted?: ReadonlySet<string>) {
  const classes: R8 = new Map();
  let current: { name: string; methods: Map<string, Set<string>> } | undefined;
  const line = (text: string) => {
    if (text.startsWith('#') || !text.trim()) return;
    if (!text.startsWith(' ')) {
      const cls = /^(\S+) -> (\S+):$/.exec(text);
      current = undefined;
      if (!cls?.[1] || !cls[2] || (wanted && !wanted.has(cls[2]))) return;
      current = { name: cls[1], methods: new Map() };
      classes.set(cls[2], current);
      return;
    }
    if (!current) return;
    const method = /^\s+(?:\d+:\d+:)?\S+ ([^\s(]+)\(.*\)(?::\d+(?::\d+)?)? -> (\S+)$/.exec(text);
    if (!method?.[1] || !method[2]) return;
    const names = current.methods.get(method[2]) ?? new Set();
    names.add(method[1].includes('.') ? method[1] : `${current.name}.${method[1]}`);
    current.methods.set(method[2], names);
  };
  return { line, classes };
}

export function parseR8(text: string): R8 {
  const reader = r8Reader();
  for (const line of text.split('\n')) reader.line(line);
  return reader.classes;
}

/** The obfuscated classes a profile's frames could name: `a.b` of `a.b.c`, and the symbol itself. */
export function r8Classes(profiles: readonly Profile[]): Set<string> {
  const wanted = new Set<string>();
  for (const p of profiles)
    for (const f of p.frames) {
      const m = SYMBOL.exec(f.name);
      if (m?.[1]) wanted.add(m[1]);
      wanted.add(f.name);
    }
  return wanted;
}

/** Streams an R8 mapping file, keeping the `wanted` classes. */
export async function loadR8(path: string, wanted: ReadonlySet<string>): Promise<R8> {
  const reader = r8Reader(wanted);
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) reader.line(line);
  return reader.classes;
}

/** `a.b.c` (an obfuscated class `a.b` and method `c`) to its original name; anything else unchanged. */
export function deobfuscate(r8: R8, symbol: string): string {
  const m = SYMBOL.exec(symbol);
  if (!m?.[1] || !m[2]) return r8.get(symbol)?.name ?? symbol;
  const cls = r8.get(m[1]);
  if (!cls) return symbol;
  const methods = cls.methods.get(m[2]);
  return methods ? [...methods].join(' | ') : `${cls.name}.${m[2]}`;
}

export function deobfuscateProfile(p: Profile, r8: R8): Profile {
  return mapFrames(p, (f) => ({ ...f, name: deobfuscate(r8, f.name) }));
}
