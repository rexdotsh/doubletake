// The app side of doubletake. Every line is one event with the app's Date.now() at the moment it happened:
// the host reads them from the simulator's log stream or logcat and sums those inside a run's window.
// Nothing runs on a timer: a line is written only when something happens (a mark, a late frame, a request).

import { type Probe, installProbe } from './probe';

export type { ProbeRead, ProbeRequest } from './probe';

type Options = {
  /** Report late JS frames from a requestAnimationFrame loop (RN's "JS FPS"). Default true. */
  frames?: boolean;
  /** Report finished XMLHttpRequest (and so fetch) requests with their response bytes. Default true. */
  network?: boolean;
  /** The display's refresh rate, for counting dropped frames. Default 60. */
  hz?: number;
};

const PREFIX = '[doubletake]';
let started = false;

function write(line: string): void {
  // Release iOS builds drop JS logs below error level, so write at error level (3) straight to the native
  // logger: it reaches os_log and logcat without going through console patches such as crash reporters.
  const hook: unknown = Reflect.get(globalThis, 'nativeLoggingHook');
  if (typeof hook === 'function') Reflect.apply(hook, undefined, [`${PREFIX} ${line}`, 3]);
  // oxlint-disable-next-line no-console -- dev builds and tests without React Native's native logger
  else console.log(`${PREFIX} ${line}`);
}

function watchFrames(hz: number): void {
  const interval = 1000 / hz;
  let previous = 0;
  const frame = (now: number) => {
    if (previous) {
      const dt = now - previous;
      const missed = Math.round(dt / interval) - 1;
      if (missed > 0) write(`f ${Date.now()} ${missed} ${Math.round(dt - interval)}`);
    }
    previous = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function size(body: unknown): number {
  if (typeof body === 'string') return body.length;
  if (body && typeof body === 'object' && 'byteLength' in body && typeof body.byteLength === 'number')
    return body.byteLength;
  if (body && typeof body === 'object' && 'size' in body && typeof body.size === 'number') return body.size;
  return 0;
}

function watchRequests(): boolean {
  if (typeof XMLHttpRequest === 'undefined') return false;
  const proto = XMLHttpRequest.prototype;
  const send: unknown = Reflect.get(proto, 'send');
  if (typeof send !== 'function') return false;
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    this.addEventListener('loadend', () => {
      const length = Number(this.getResponseHeader('content-length'));
      write(`r ${Date.now()} ${length > 0 ? length : size(this.response)}`);
    });
    Reflect.apply(send, this, [body]);
  };
  return true;
}

/** Starts reporting. Call once, as early as possible (the app's entry file). */
export function start(options: Options = {}): void {
  if (started) return;
  started = true;
  let families = '';
  if (options.frames !== false && typeof requestAnimationFrame === 'function') {
    watchFrames(options.hz ?? 60);
    families += 'f';
  }
  if (options.network !== false && watchRequests()) families += 'n';
  write(`s ${Date.now()} ${families || '-'}`);
}

/** Marks a moment, such as the first screen with content: `mark('home')` gives the metric `mark.home`. */
export function mark(name: string): void {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`doubletake: a mark name is letters, digits, _ . and - (${name})`);
  write(`m ${Date.now()} ${name}`);
}

/** Pass as a React `<Profiler onRender>` to count commits and render time (profiling builds only). */
export function onRender(_id: string, _phase: string, actualDuration: number): void {
  write(`p ${Date.now()} ${actualDuration.toFixed(1)}`);
}

/**
 * Installs the screen probe (React commits and component renders, requests with their timing) as
 * `globalThis.__doubletake_probe__`; it counts only between its `begin()` and `read()`. Call it first in the app's
 * entry file, before React loads, when a bridge reads it in a release build; over CDP, doubletake injects it itself.
 */
export function probe(): Probe {
  return installProbe(globalThis);
}
