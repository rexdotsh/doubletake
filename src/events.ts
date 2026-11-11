// Lines the SDK writes (sdk/index.ts): `[doubletake] s <t>`, `m <t> <name>` and `c <t> <counters…>`,
// with t the app's Date.now(). The host reads them from os_log or logcat, whatever the line's prefix.

export type Counters = {
  frames: number;
  dropped: number;
  stall: number;
  requests: number;
  bytes: number;
  commits: number;
  render: number;
};

export type SdkEvent =
  | { kind: 'start'; t: number }
  | { kind: 'mark'; t: number; name: string }
  | ({ kind: 'counters'; t: number } & Counters);

const COUNTERS = ['frames', 'dropped', 'stall', 'requests', 'bytes', 'commits', 'render'] as const;

export function parseSdkLine(text: string): SdkEvent | null {
  const prefix = text.indexOf('[doubletake] ');
  if (prefix < 0) return null;
  const [kind, time, ...rest] = text
    .slice(prefix + 13)
    .trim()
    .split(/\s+/);
  const t = Number(time);
  if (!Number.isFinite(t)) return null;
  if (kind === 's') return { kind: 'start', t };
  if (kind === 'm' && rest[0]) return { kind: 'mark', t, name: rest[0] };
  if (kind === 'c' && rest.length === COUNTERS.length) {
    const [frames, dropped, stall, requests, bytes, commits, render] = rest.map(Number);
    const counters = { frames, dropped, stall, requests, bytes, commits, render };
    if (!isCounters(counters)) return null;
    return { kind: 'counters', t, ...counters };
  }
  return null;
}

function isCounters(c: Record<keyof Counters, number | undefined>): c is Counters {
  return COUNTERS.every((k) => Number.isFinite(c[k]));
}

const ZERO: Counters = { frames: 0, dropped: 0, stall: 0, requests: 0, bytes: 0, commits: 0, render: 0 };

/** Counters at time t: the last sample at or before it since `since`. The SDK writes only on change. */
function at(events: readonly SdkEvent[], t: number, since: number): Counters {
  let found: Counters = ZERO;
  for (const e of events) if (e.kind === 'counters' && e.t >= since && e.t <= t) found = e;
  return found;
}

/**
 * What the counters grew by between two times (device clock), within the app process that was running at `to`
 * (each launch starts them at zero). Undefined when the SDK never started in that window.
 */
export function countersIn(events: readonly SdkEvent[], from: number, to: number): Counters | undefined {
  const starts = events.filter((e) => e.kind === 'start' && e.t <= to);
  const since = starts.at(-1)?.t;
  if (since === undefined) return undefined;
  const a = at(events, from, since);
  const b = at(events, to, since);
  return {
    frames: b.frames - a.frames,
    dropped: b.dropped - a.dropped,
    stall: b.stall - a.stall,
    requests: b.requests - a.requests,
    bytes: b.bytes - a.bytes,
    commits: b.commits - a.commits,
    render: b.render - a.render,
  };
}

export function marksAfter(events: readonly SdkEvent[], t: number): Map<string, number> {
  const marks = new Map<string, number>();
  for (const e of events) if (e.kind === 'mark' && e.t >= t && !marks.has(e.name)) marks.set(e.name, e.t);
  return marks;
}
