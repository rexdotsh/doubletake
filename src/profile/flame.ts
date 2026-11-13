import { get } from '../util.ts';
import { type Profile, frameKey } from './model.ts';

// A flame graph as one SVG file with nothing to load: callers above callees (an icicle), widths in time, a
// colour per module, and each box's numbers in its tooltip.

type Node = { label: string; module: string; ms: number; self: number; children: Map<string, Node> };

const WIDTH = 1200;
const ROW = 17;
const CHAR = 6.6;

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

function hue(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 360;
}

function tree(p: Profile): Node {
  const root: Node = { label: 'all', module: '', ms: 0, self: 0, children: new Map() };
  const into = (parent: Node, key: string, label: string, module: string, ms: number) => {
    let n = parent.children.get(key);
    if (!n) {
      n = { label, module, ms: 0, self: 0, children: new Map() };
      parent.children.set(key, n);
    }
    n.ms += ms;
    return n;
  };
  for (const s of p.stacks) {
    root.ms += s.ms;
    let at = s.thread === undefined ? root : into(root, `thread ${s.thread}`, s.thread, '(thread)', s.ms);
    for (const i of s.frames) {
      const f = get(p.frames, i);
      at = into(at, frameKey(f), f.name, f.module, s.ms);
    }
    at.self += s.ms;
  }
  return root;
}

const ms = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(1));

/** The profile as a self-contained SVG flame graph. */
export function flameSvg(p: Profile, title: string): string {
  const root = tree(p);
  const scale = root.ms > 0 ? WIDTH / root.ms : 0;
  const boxes: string[] = [];
  let depth = 0;
  const draw = (n: Node, x: number, level: number) => {
    const w = n.ms * scale;
    if (w < 0.3) return;
    depth = Math.max(depth, level);
    const y = 30 + level * ROW;
    const tip = `${n.label}${n.module ? ` (${n.module})` : ''}\n${ms(n.ms)} ms total (${((100 * n.ms) / root.ms).toFixed(1)}%), ${ms(n.self)} ms self`;
    const fill =
      level === 0
        ? '#ccc'
        : n.module === '(thread)'
          ? '#bbb'
          : `hsl(${hue(n.module)},70%,${65 + (hue(n.label) % 15)}%)`;
    const chars = Math.floor((w - 4) / CHAR);
    const text = chars >= 3 ? (n.label.length > chars ? `${n.label.slice(0, chars - 1)}…` : n.label) : '';
    boxes.push(
      `<g><title>${escape(tip)}</title><rect x="${x.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${ROW - 1}" fill="${fill}" rx="2"/>${text ? `<text x="${(x + 3).toFixed(2)}" y="${y + 12}">${escape(text)}</text>` : ''}</g>`,
    );
    let cx = x;
    for (const c of [...n.children.values()].toSorted((a, b) => b.ms - a.ms)) {
      draw(c, cx, level + 1);
      cx += c.ms * scale;
    }
  };
  draw(root, 0, 0);
  const height = 30 + (depth + 1) * ROW + 10;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="Menlo,monospace" font-size="11">`,
    `<text x="4" y="18" font-size="13">${escape(`${title} · ${p.profiler} · ${ms(root.ms)} ms`)}</text>`,
    ...boxes,
    '</svg>',
  ].join('\n');
}
