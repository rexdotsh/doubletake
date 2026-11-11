// The marker protocol: one line per event, `[doubletake] <kind> <t> …`, with t the app's Date.now() when
// it happened. Any app can write it: the RN SDK (sdk/index.ts) through React Native's logger, a native app
// through os_log or android.util.Log. The host reads it from the log, whatever the logger put before it.
//   s <t> <families>   the app started reporting; families: f (frames), n (network), or -
//   m <t> <name>       a mark
//   f <t> <missed> <late ms>   a JS frame that came late
//   r <t> <bytes>      a request finished
//   p <t> <ms>         a React commit (profiling builds)

export type SdkEvent =
  | { kind: 'start'; t: number; frames: boolean; network: boolean }
  | { kind: 'mark'; t: number; name: string }
  | { kind: 'frame'; t: number; missed: number; late: number }
  | { kind: 'request'; t: number; bytes: number }
  | { kind: 'commit'; t: number; ms: number };

export type Counters = {
  dropped: number;
  stall: number;
  requests: number;
  bytes: number;
  commits: number;
  render: number;
};

export function parseSdkLine(text: string): SdkEvent | null {
  const prefix = text.indexOf('[doubletake] ');
  if (prefix < 0) return null;
  const [kind, time, a, b] = text
    .slice(prefix + 13)
    .trim()
    .split(/\s+/);
  const t = Number(time);
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(t)) return null;
  if (kind === 's') return { kind: 'start', t, frames: a?.includes('f') ?? false, network: a?.includes('n') ?? false };
  if (kind === 'm' && a) return { kind: 'mark', t, name: a };
  if (kind === 'f' && Number.isFinite(x) && Number.isFinite(y)) return { kind: 'frame', t, missed: x, late: y };
  if (kind === 'r' && Number.isFinite(x)) return { kind: 'request', t, bytes: x };
  if (kind === 'p' && Number.isFinite(x)) return { kind: 'commit', t, ms: x };
  return null;
}

/**
 * What happened in [from, to] (device clock), in the app process that started at `launched`: only that
 * process's own start line counts, so a launch that never reports is refused, not read as zeros.
 */
export function countersIn(
  events: readonly SdkEvent[],
  from: number,
  to: number,
  launched: number,
): { counters: Counters; frames: boolean; network: boolean } | undefined {
  const start = events.findLast((e) => e.kind === 'start' && e.t >= launched && e.t <= to);
  if (start?.kind !== 'start') return undefined;
  const counters: Counters = { dropped: 0, stall: 0, requests: 0, bytes: 0, commits: 0, render: 0 };
  for (const e of events) {
    if (e.t < Math.max(from, start.t) || e.t > to) continue;
    if (e.kind === 'frame') {
      counters.dropped += e.missed;
      counters.stall += e.late;
    } else if (e.kind === 'request') {
      counters.requests++;
      counters.bytes += e.bytes;
    } else if (e.kind === 'commit') {
      counters.commits++;
      counters.render += e.ms;
    }
  }
  return { counters, frames: start.frames, network: start.network };
}

/** The first time each mark was written in [from, to]. */
export function marksIn(events: readonly SdkEvent[], from: number, to: number): Map<string, number> {
  const marks = new Map<string, number>();
  for (const e of events)
    if (e.kind === 'mark' && e.t >= from && e.t <= to && !marks.has(e.name)) marks.set(e.name, e.t);
  return marks;
}
