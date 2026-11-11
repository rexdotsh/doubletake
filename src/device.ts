import type { Platform } from './metrics.ts';
import { parseSdkLine } from './events.ts';
import { sleep, stop, stream } from './sh.ts';
import type { SdkEvent } from './events.ts';

export type Launched = {
  /** When the app process started, host clock (ms since the epoch). */
  t0: number;
  pid: number;
  /** The platform's own time to first frame, when it gives one. */
  ttid?: number;
};

type Memory = { endMiB?: number; peakMiB?: number };

export type Action =
  | { tap: [number, number] | string }
  | { swipe: { from: [number, number]; to: [number, number]; duration: number } };

type Frames = { total: number; janky: number; p90: number };

/** SDK lines from the app, collected while a block runs. */
export interface LogTap {
  readonly events: SdkEvent[];
  /** Resolves with the first matching event at or after `since` (device clock), once it arrives. */
  waitFor(match: (e: SdkEvent) => boolean, since: number, timeout: number): Promise<SdkEvent>;
  stop(): Promise<void>;
}

export interface Recording {
  /** Host clock of the video's first frame, when the platform says it (simctl does; screenrecord does not). */
  readonly startedAt?: number;
  /** Stops recording and returns the local path of the video. */
  stop(): Promise<string>;
}

export interface Device {
  readonly platform: Platform;
  readonly id: string;
  readonly name: string;
  readonly os: string;
  /** Status bar, animations: whatever makes runs and videos comparable. */
  prepare(): Promise<void>;
  appId(artifact: string): Promise<string>;
  /** A copy of a build under another bundle id, so both sides stay installed (iOS only). */
  clone?(artifact: string, appId: string, dir: string): Promise<string>;
  install(artifact: string): Promise<void>;
  isInstalled(appId: string): Promise<boolean>;
  terminate(appId: string): Promise<void>;
  launch(appId: string): Promise<Launched>;
  /** The process's user + system CPU time so far: cheap, read right at a window's edges. */
  cpuMs(pid: number): Promise<number>;
  memory(pid: number, appId: string): Promise<Memory>;
  logs(appId: string): Promise<LogTap>;
  /** Device clock minus host clock, ms. */
  clockOffset(): Promise<number>;
  record(path: string): Promise<Recording>;
  openUrl(url: string): Promise<void>;
  /** UI frames since the last reset, where the platform reports them. */
  frames?: { reset(appId: string): Promise<void>; read(appId: string): Promise<Frames> };
  /** Taps and swipes in order. iOS has no input of its own, so they go through one Maestro flow there. */
  input(appId: string, actions: readonly Action[]): Promise<void>;
}

/** A measurement doubletake will not give, with the validator that refused it (exit 4). */
export class Refusal extends Error {
  readonly validator: string;
  constructor(validator: string, message: string) {
    super(message);
    this.validator = validator;
  }
}

/** Streams a log command, keeps the SDK's lines (`extract` gives a line's message and writer), and waits on them. */
export async function logTap(
  cmd: string,
  args: readonly string[],
  extract: (line: string) => { message: string; pid?: number } | null,
): Promise<LogTap> {
  const events: SdkEvent[] = [];
  const waiters = new Set<() => void>();
  const child = stream(cmd, args, (line) => {
    const got = extract(line);
    const event = got === null ? null : parseSdkLine(got.message);
    if (!event) return;
    events.push(got?.pid === undefined ? event : { ...event, pid: got.pid });
    for (const wake of waiters) wake();
  });
  await sleep(LOG_ATTACH_MS);
  return {
    events,
    waitFor(match, since, timeout) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = events.find((e) => e.t >= since && match(e));
          if (!found) return;
          cleanup();
          resolve(found);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Refusal('NoMarker', `no matching SDK line within ${timeout} ms`));
        }, timeout);
        const cleanup = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      });
    },
    stop: () => stop(child),
  };
}

// A log stream misses lines written before it attaches; give it this long before the first launch.
const LOG_ATTACH_MS = 1500;
