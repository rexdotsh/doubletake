import type { ProbeRequest } from '../sdk/probe.ts';
import { isRecord } from './util.ts';

// The app adapter: what a screen did inside the app over a run's window (React commits and component renders,
// requests), from a transport the bench names. Both transports feed one shape, ProbeDetail.

export type BridgeConfig = {
  /** The link that runs a bridge script: `{nonce}` and `{script}` (URL-encoded) are filled in. */
  link: string;
  /** Reply lines in the device log: `<reply> <nonce> <i>/<n> <json chunk>`. */
  reply: string;
  /** The script that opens a window (starts counting from zero). */
  begin: string;
  /**
   * The script that answers with the window's counts; `{from}` and `{to}` (device-clock ms since the epoch) are
   * filled in for a bridge that counts exactly the window (the probe's `read(from, to)`).
   */
  read: string;
  /** Picks the counts out of the reply to `read`, when the bridge wraps them. */
  parse?: (reply: unknown) => unknown;
};

/** `cdp`: Metro's URL (dev clients: doubletake injects the probe). `bridge`: a deep link and log replies. */
export type ProbeConfig = { cdp: string } | { bridge: BridgeConfig };

/** A window's counts, from either transport; a field the transport did not give is absent. */
export type ProbeDetail = {
  ms: number;
  commits?: number;
  renders?: number;
  mounts?: number;
  /** Most renders first. */
  components?: { name: string; renders: number; mounts: number }[];
  requests?: number;
  /** Requests that repeat an earlier one in the window: same method, URL, query and body. */
  duplicates?: number;
  bytes?: number;
  /** Requests by method and URL (`?#…`: a query hash, `body#…`: a body hash), most first. */
  keys?: { key: string; count: number; bytes: number }[];
  /** Every request in the window in start order, ms from its start; `end` is absent while in flight. */
  waterfall?: ProbeRequest[];
  /**
   * How much longer (or shorter) than the measured window the app counted, ms: 0 when the app counted exactly the
   * window (the probe's bounded read).
   */
  overrun?: number;
};

/** The measured window, device clock (ms since the epoch). */
export type ProbeWindow = { from: number; to: number };

export interface ProbeSession {
  /** Opens a window: counting starts from zero. */
  begin(): Promise<void>;
  /** Returns the counts inside `window`, with the metrics it cannot give and why; counting stops. */
  read(window: ProbeWindow): Promise<{ detail: ProbeDetail; refused: Record<string, string> }>;
  stop(): Promise<void>;
}

export const PROBE_METRICS = ['probe.commits', 'probe.renders', 'probe.requests', 'probe.duplicates', 'probe.bytes'];
const RENDER_METRICS = ['probe.commits', 'probe.renders'];
const NET_METRICS = ['probe.requests', 'probe.duplicates', 'probe.bytes'];
const TOP_KEYS = 12;
const WATERFALL = 100;
const COMPONENTS = 40;

function string(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${where}: expected a string`);
  return value;
}

/** Validates the bench's `probe` once, at the edge. */
export function probeConfig(value: unknown): ProbeConfig {
  if (!isRecord(value)) throw new Error('probe: expected { cdp: <metro url> } or { bridge: { … } }');
  const keys = Object.keys(value);
  if (keys.length !== 1 || (keys[0] !== 'cdp' && keys[0] !== 'bridge'))
    throw new Error('probe: one of cdp (a Metro URL) or bridge');
  if ('cdp' in value) {
    const url = string(value.cdp, 'probe.cdp');
    if (!/^https?:\/\//.test(url)) throw new Error("probe.cdp: Metro's URL, such as http://localhost:8081");
    return { cdp: url.replace(/\/$/, '') };
  }
  const b = value.bridge;
  if (!isRecord(b)) throw new Error('probe.bridge: expected an object');
  for (const key of Object.keys(b))
    if (!['link', 'reply', 'begin', 'read', 'parse'].includes(key))
      throw new Error(`probe.bridge: unknown key ${key} (known: link, reply, begin, read, parse)`);
  const link = string(b.link, 'probe.bridge.link');
  if (!link.includes('{nonce}') || !link.includes('{script}'))
    throw new Error('probe.bridge.link: needs {nonce} and {script}, such as myapp://lab?n={nonce}&c={script}');
  const parse = b.parse;
  if (parse !== undefined && typeof parse !== 'function') throw new Error('probe.bridge.parse: expected a function');
  return {
    bridge: {
      link,
      reply: string(b.reply, 'probe.bridge.reply'),
      begin: string(b.begin, 'probe.bridge.begin'),
      read: string(b.read, 'probe.bridge.read'),
      parse: parse === undefined ? undefined : (reply) => Reflect.apply(parse, undefined, [reply]),
    },
  };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

function requestKey(r: Pick<ProbeRequest, 'method' | 'url' | 'query' | 'body'>): string {
  return `${r.method} ${r.url}${r.query ? `?#${r.query}` : ''}${r.body ? ` body#${r.body}` : ''}`;
}

function request(value: unknown): ProbeRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { method, url, query, body } = value;
  const start = num(value.start);
  if (typeof method !== 'string' || typeof url !== 'string' || start === undefined) return undefined;
  return {
    method,
    url,
    query: typeof query === 'string' ? query : '',
    body: typeof body === 'string' ? body : '',
    status: num(value.status) ?? 0,
    bytes: num(value.bytes) ?? 0,
    start,
    headers: num(value.headers),
    end: num(value.end),
  };
}

/** Requests grouped by key, duplicates counted. */
function network(requests: readonly ProbeRequest[]): Pick<ProbeDetail, 'requests' | 'duplicates' | 'bytes' | 'keys'> {
  const byKey = new Map<string, { count: number; bytes: number }>();
  for (const r of requests) {
    const k = byKey.get(requestKey(r)) ?? { count: 0, bytes: 0 };
    k.count++;
    k.bytes += r.bytes;
    byKey.set(requestKey(r), k);
  }
  const keys = [...byKey]
    .map(([key, k]) => ({ key, count: k.count, bytes: k.bytes }))
    .toSorted((a, b) => b.count - a.count || b.bytes - a.bytes);
  return {
    requests: requests.length,
    duplicates: keys.reduce((sum, k) => sum + k.count - 1, 0),
    bytes: requests.reduce((sum, r) => sum + r.bytes, 0),
    keys: keys.slice(0, TOP_KEYS),
  };
}

/** How far an app's counting may stray from the measured window before its counts are refused. */
function tolerance(window: ProbeWindow): number {
  return Math.max(300, 0.05 * (window.to - window.from));
}

function refuseAll(refused: Record<string, string>, metrics: readonly string[], why: string): void {
  for (const m of metrics) refused[m] ??= why;
}

/** The probe's own record: complete lists or refusals, never a short count. */
function readRecord(value: Record<string, unknown>, detail: ProbeDetail, refused: Record<string, string>): void {
  const raw = value.requests;
  const requests = Array.isArray(raw) ? raw.map(request) : [];
  const valid = requests.filter((r) => r !== undefined);
  const dropped = num(value.dropped);
  if (value.network === false)
    refuseAll(refused, NET_METRICS, 'NoNetwork: the app has no XMLHttpRequest for the probe to watch');
  else if (!Array.isArray(raw)) refuseAll(refused, NET_METRICS, 'InvalidProbe: no request list');
  else if (valid.length < requests.length)
    refuseAll(
      refused,
      NET_METRICS,
      `InvalidProbe: ${requests.length - valid.length} of ${requests.length} request entries unreadable`,
    );
  else if (dropped !== 0)
    refuseAll(
      refused,
      NET_METRICS,
      `Overflow: the app kept ${valid.length} requests and dropped ${dropped ?? 'an unknown number'}`,
    );
  else {
    Object.assign(detail, network(valid), {
      waterfall: valid.toSorted((a, b) => a.start - b.start).slice(0, WATERFALL),
    });
    const unknown = valid.filter((r) => r.body === '?').length;
    if (unknown) {
      detail.duplicates = undefined;
      refused['probe.duplicates'] = `UnknownBody: ${unknown} request bodies the probe cannot fingerprint`;
    }
  }
  const renderers = num(value.renderers);
  const droppedCommits = num(value.droppedCommits);
  if (renderers === undefined) refuseAll(refused, RENDER_METRICS, 'InvalidProbe: no renderer count');
  else if (renderers === 0)
    refuseAll(
      refused,
      RENDER_METRICS,
      'NoRenderer: React started before the probe, so no commit reaches it (install it first in the entry file, or use a dev client)',
    );
  else if (droppedCommits !== 0)
    refuseAll(
      refused,
      RENDER_METRICS,
      `Overflow: the app dropped ${droppedCommits ?? 'an unknown number of'} commits past its cap`,
    );
  else {
    detail.commits = num(value.commits);
    detail.renders = num(value.renders);
    detail.mounts = num(value.mounts);
    detail.components = (Array.isArray(value.components) ? value.components : [])
      .filter((c): c is unknown[] => Array.isArray(c))
      .map(([name, renders, mounts]) => ({ name: String(name), renders: num(renders) ?? 0, mounts: num(mounts) ?? 0 }))
      .slice(0, COMPONENTS);
  }
}

/** What a simpler bridge gives: totals only. */
function readAggregate(value: Record<string, unknown>, detail: ProbeDetail, refused: Record<string, string>): void {
  if (num(value.renderers) === 0)
    refuseAll(refused, RENDER_METRICS, 'NoRenderer: the app says no React renderer reached its hook');
  else {
    detail.commits = num(value.commits);
    detail.renders = num(value.renders);
  }
  detail.requests = num(value.requests);
  detail.duplicates = num(value.duplicates);
  detail.bytes = num(value.bytes);
  if (Array.isArray(value.top))
    detail.keys = value.top
      .filter(isRecord)
      .map((k) => ({ key: String(k.key), count: num(k.count) ?? 0, bytes: num(k.bytes) ?? 0 }))
      .slice(0, TOP_KEYS);
}

/**
 * How far the app's counting strayed from the window: 0 for the probe's read of exactly the window; from the
 * record's own bounds (it began before the window and read after it); else from an aggregate's `ms`.
 */
function overrun(value: Record<string, unknown>, window: ProbeWindow): number | undefined {
  const from = num(value.from);
  const to = num(value.to);
  if (from !== undefined && to !== undefined) return Math.abs(from - window.from) + Math.abs(to - window.to);
  const ms = num(value.ms);
  return ms === undefined ? undefined : Math.abs(ms - (window.to - window.from));
}

/**
 * Reads a window's counts from untrusted app output: the probe's own record (`doubletake.probe.v1`), or the
 * aggregate a simpler bridge can give (`requests`, `duplicates`, `bytes`, `top: [{ key, count }]`, `commits`,
 * `renders`, `renderers`, `ms`), any subset of them. Counts over a span that strays from the window by more than
 * the tolerance are refused.
 */
export function readProbe(
  value: unknown,
  window: ProbeWindow,
): { detail: ProbeDetail; refused: Record<string, string> } {
  const refused: Record<string, string> = {};
  if (!isRecord(value)) {
    refuseAll(refused, PROBE_METRICS, 'NoProbe: the app gave no counts');
    return { detail: { ms: 0 }, refused };
  }
  const detail: ProbeDetail = { ms: num(value.ms) ?? 0 };
  if (value.schema === 'doubletake.probe.v1') readRecord(value, detail, refused);
  else readAggregate(value, detail, refused);
  const off = overrun(value, window);
  if (off === undefined)
    refuseAll(refused, PROBE_METRICS, 'NoWindow: the app said neither which span it counted nor how long');
  else {
    detail.overrun = Math.round(off);
    if (off > tolerance(window))
      refuseAll(
        refused,
        PROBE_METRICS,
        `WindowOverrun: the app counted a span ${Math.round(off)} ms off the ${Math.round(window.to - window.from)} ms window (a bridge that takes {from} and {to} counts it exactly)`,
      );
  }
  const values = probeValues(detail);
  for (const m of PROBE_METRICS)
    if (values[m] === undefined) refused[m] ??= `NoProbe: the app's counts have no ${m.slice('probe.'.length)}`;
  return { detail: scrub(detail, refused), refused };
}

/** A refused metric's numbers leave the detail too, so no report shows them as measured. */
function scrub(detail: ProbeDetail, refused: Record<string, string>): ProbeDetail {
  const out = { ...detail };
  if (refused['probe.commits']) out.commits = undefined;
  if (refused['probe.renders']) Object.assign(out, { renders: undefined, mounts: undefined, components: undefined });
  if (refused['probe.requests']) Object.assign(out, { requests: undefined, waterfall: undefined });
  if (refused['probe.duplicates']) Object.assign(out, { duplicates: undefined, keys: undefined });
  if (refused['probe.bytes']) out.bytes = undefined;
  return out;
}

/** The window's probe metrics, for a run's values. */
export function probeValues(detail: ProbeDetail): Record<string, number> {
  const values: Record<string, number> = {};
  const fields: [string, number | undefined][] = [
    ['probe.commits', detail.commits],
    ['probe.renders', detail.renders],
    ['probe.requests', detail.requests],
    ['probe.duplicates', detail.duplicates],
    ['probe.bytes', detail.bytes],
  ];
  for (const [m, v] of fields) if (v !== undefined) values[m] = v;
  return values;
}

/** The run whose renders (else requests) are the median of its side's: the detail a report shows. */
export function typical(details: readonly ProbeDetail[]): ProbeDetail | undefined {
  const by = (d: ProbeDetail) => d.renders ?? d.requests ?? 0;
  const sorted = details.toSorted((a, b) => by(a) - by(b));
  return sorted[(sorted.length - 1) >> 1];
}
