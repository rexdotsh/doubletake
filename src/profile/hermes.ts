import { get, isRecord } from '../util.ts';
import { type Frame, type Profile, builder, weights } from './model.ts';

// Hermes writes two formats: Chrome's `.cpuprofile` (the CDP Profiler domain, on a dev build through Metro's
// inspector) and a Chrome trace with `stackFrames` and `samples` (its sampling profiler's dump, on any build).
// Both come with bundle positions only; symbols.ts maps them to source.

/** Frames that are the profiler's own bookkeeping, not code: never a function in a report. */
const META = new Set(['(root)', '[root]', '(program)']);
/** Frames that mean the thread was not running JS. */
const IDLE = new Set(['(idle)', '[idle]']);

/** A JSON scalar as text; anything else as empty. */
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : Number.NaN);

/** `foo(1:2345)` (Hermes appends the bundle position to a JS frame's name) to `foo`. */
const bare = (name: string) => name.replace(/\(\d+:\d+\)$/, '') || '(anonymous)';

function jsFrame(name: string, line: number, column: number): Frame {
  return Number.isFinite(line) && Number.isFinite(column)
    ? { name: bare(name), module: '(bundle)', at: { line, column } }
    : { name: bare(name), module: name.startsWith('(') || name.startsWith('[') ? '(hermes)' : '(native)' };
}

/** Chrome's `.cpuprofile`: a node tree, sample node ids and the µs between samples. */
export function parseCpuProfile(json: unknown): Profile {
  const nodes = isRecord(json) && Array.isArray(json.nodes) ? json.nodes : undefined;
  const samples = isRecord(json) && Array.isArray(json.samples) ? json.samples : undefined;
  const deltas = isRecord(json) && Array.isArray(json.timeDeltas) ? json.timeDeltas : undefined;
  if (!nodes || !samples || !deltas) throw new Error('not a .cpuprofile: no nodes, samples and timeDeltas');
  const b = builder('js', 'hermes');
  const byId = new Map<number, { frame?: number; parent?: number; idle: boolean }>();
  const parents = new Map<number, number>();
  for (const n of nodes) {
    const id = num(isRecord(n) ? n.id : undefined);
    const children = isRecord(n) && Array.isArray(n.children) ? n.children : [];
    for (const c of children) parents.set(num(c), id);
  }
  for (const n of nodes) {
    if (!isRecord(n) || !isRecord(n.callFrame)) continue;
    const id = num(n.id);
    const name = str(n.callFrame.functionName) || '(anonymous)';
    const line = num(n.callFrame.lineNumber);
    const column = num(n.callFrame.columnNumber);
    const url = str(n.callFrame.url);
    const coded = url !== '' && line >= 0 && column >= 0;
    byId.set(id, {
      frame: META.has(name) || IDLE.has(name) ? undefined : b.frame(jsFrame(name, coded ? line + 1 : NaN, column)),
      parent: parents.get(id) ?? (typeof n.parent === 'number' ? n.parent : undefined),
      idle: IDLE.has(name),
    });
  }
  let t = num(isRecord(json) ? json.startTime : 0) || 0;
  const times = deltas.map((d) => (t += num(d)));
  const ms = weights(times);
  let idle = 0;
  samples.forEach((s, i) => {
    const path: number[] = [];
    let node = byId.get(num(s));
    if (node?.idle) {
      idle += get(ms, i);
      return;
    }
    for (; node; node = node.parent === undefined ? undefined : byId.get(node.parent))
      if (node.frame !== undefined) path.unshift(node.frame);
    if (path.length) b.add(undefined, path, get(ms, i));
    else idle += get(ms, i);
  });
  return b.done(idle ? [`${Math.round(idle)} ms with no JS on the stack left out`] : []);
}

/** A Hermes sampling profiler dump: `stackFrames` by id with parents, `samples` naming their leaf frame. */
export function parseHermesTrace(json: unknown): Profile {
  const frames = isRecord(json) && isRecord(json.stackFrames) ? json.stackFrames : undefined;
  const samples = isRecord(json) && Array.isArray(json.samples) ? json.samples : undefined;
  if (!frames || !samples) throw new Error('not a Hermes trace: no stackFrames and samples');
  const b = builder('js', 'hermes');
  const known = new Map<string, number | undefined>();
  const frameOf = (id: string): number | undefined => {
    if (known.has(id)) return known.get(id);
    const f = frames[id];
    if (!isRecord(f)) return undefined;
    const name = str(f.name);
    let at: number | undefined;
    if (!META.has(name) && !IDLE.has(name) && f.category !== 'root') {
      // Without debug info a frame has its function's bytecode address and an offset in it; the bundle is line 1.
      const virtual = f.funcVirtAddr !== undefined && f.offset !== undefined;
      const line = virtual ? 1 : num(f.line);
      const column = virtual ? num(f.funcVirtAddr) + num(f.offset) : num(f.column);
      at = b.frame(f.category === 'JavaScript' ? jsFrame(name, line, column) : jsFrame(name, NaN, NaN));
    }
    known.set(id, at);
    return at;
  };
  const byThread = new Map<string, { ts: number; sf: string }[]>();
  for (const s of samples) {
    if (!isRecord(s) || s.sf === undefined) continue;
    const tid = str(s.tid);
    const list = byThread.get(tid) ?? [];
    list.push({ ts: num(s.ts), sf: str(s.sf) });
    byThread.set(tid, list);
  }
  let idle = 0;
  for (const list of byThread.values()) {
    list.sort((x, y) => x.ts - y.ts);
    const ms = weights(list.map((s) => s.ts));
    list.forEach((s, i) => {
      const path: number[] = [];
      for (let id: string | undefined = s.sf; id !== undefined;) {
        const f: unknown = frames[id];
        const at = frameOf(id);
        if (at !== undefined) path.unshift(at);
        id = isRecord(f) && f.parent !== undefined ? str(f.parent) : undefined;
      }
      if (path.length) b.add(undefined, path, get(ms, i));
      else idle += get(ms, i);
    });
  }
  return b.done(idle ? [`${Math.round(idle)} ms with no JS on the stack left out`] : []);
}

/** Either Hermes format, by its shape. */
export function parseJsProfile(json: unknown): Profile {
  return isRecord(json) && 'stackFrames' in json ? parseHermesTrace(json) : parseCpuProfile(json);
}

/** Sample spacing of a written `.cpuprofile`, µs: fine enough for mean profiles' fractions of a ms. */
const WRITTEN_US = 100;

/** A profile as a `.cpuprofile` for Chrome DevTools or speedscope: each stack as evenly spaced samples. */
export function toCpuProfile(p: Profile): object {
  type Node = { id: number; callFrame: object; children: number[] };
  const nodes: Node[] = [{ id: 1, callFrame: callFrame('(root)', ''), children: [] }];
  const child = new Map<string, number>();
  const at = (parent: number, key: string, frame: object) => {
    const k = `${parent}\u0000${key}`;
    let id = child.get(k);
    if (id === undefined) {
      id = nodes.length + 1;
      nodes.push({ id, callFrame: frame, children: [] });
      get(nodes, parent - 1).children.push(id);
      child.set(k, id);
    }
    return id;
  };
  const samples: number[] = [];
  for (const s of p.stacks) {
    let node = s.thread === undefined ? 1 : at(1, `thread ${s.thread}`, callFrame(s.thread, '(thread)'));
    for (const i of s.frames) {
      const f = get(p.frames, i);
      node = at(node, String(i), callFrame(f.name, f.file ?? f.module, f.line));
    }
    for (let k = Math.round((s.ms * 1000) / WRITTEN_US); k > 0; k--) samples.push(node);
  }
  const timeDeltas = samples.map(() => WRITTEN_US);
  return { nodes, startTime: 0, endTime: samples.length * WRITTEN_US, samples, timeDeltas };
}

function callFrame(functionName: string, url: string, line?: number) {
  return { functionName, scriptId: '0', url, lineNumber: (line ?? 1) - 1, columnNumber: 0 };
}
