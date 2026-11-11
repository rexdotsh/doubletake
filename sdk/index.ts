// The app side of doubletake. It writes one log line per mark and, while started, one line of cumulative
// counters every `every` ms. The host reads them from the simulator's log stream or logcat.

type Options = {
  /** Count JS frames with a requestAnimationFrame loop (RN's "JS FPS"). Default true. */
  frames?: boolean;
  /** Count XMLHttpRequest (and so fetch) requests and response bytes. Default true. */
  network?: boolean;
  /** How often to write counters, in ms. Default 250. */
  every?: number;
  /** The display's refresh rate, for counting dropped frames. Default 60. */
  hz?: number;
};

const PREFIX = '[doubletake]';
const counters = { frames: 0, dropped: 0, stall: 0, requests: 0, bytes: 0, commits: 0, render: 0 };
let started = false;
let last = '';

function write(line: string): void {
  // Release iOS builds drop JS logs below error level, so write at error level (3) straight to the native
  // logger: it reaches os_log and logcat without going through console patches such as crash reporters.
  const hook: unknown = Reflect.get(globalThis, 'nativeLoggingHook');
  if (typeof hook === 'function') Reflect.apply(hook, undefined, [`${PREFIX} ${line}`, 3]);
  // oxlint-disable-next-line no-console -- dev builds and tests without React Native's native logger
  else console.log(`${PREFIX} ${line}`);
}

function flush(): void {
  const c = counters;
  const line = `${c.frames} ${c.dropped} ${Math.round(c.stall)} ${c.requests} ${c.bytes} ${c.commits} ${Math.round(c.render)}`;
  if (line === last) return;
  last = line;
  write(`c ${Date.now()} ${line}`);
}

function countFrames(hz: number): void {
  const interval = 1000 / hz;
  let previous = 0;
  const frame = (now: number) => {
    if (previous) {
      const dt = now - previous;
      counters.frames++;
      const missed = Math.round(dt / interval) - 1;
      if (missed > 0) {
        counters.dropped += missed;
        counters.stall += dt - interval;
      }
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

function countRequests(): void {
  if (typeof XMLHttpRequest === 'undefined') return;
  const proto = XMLHttpRequest.prototype;
  const send: unknown = Reflect.get(proto, 'send');
  if (typeof send !== 'function') return;
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    this.addEventListener('loadend', () => {
      counters.requests++;
      const length = Number(this.getResponseHeader('content-length'));
      counters.bytes += length > 0 ? length : size(this.response);
    });
    Reflect.apply(send, this, [body]);
  };
}

/** Starts counting. Call once, as early as possible (the app's entry file). */
export function start(options: Options = {}): void {
  if (started) return;
  started = true;
  if (options.frames !== false) countFrames(options.hz ?? 60);
  if (options.network !== false) countRequests();
  setInterval(flush, options.every ?? 250);
  write(`s ${Date.now()}`);
}

/** Marks a moment, such as the first screen with content: `mark('home')` gives the metric `mark.home`. */
export function mark(name: string): void {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`doubletake: a mark name is letters, digits, _ . and - (${name})`);
  flush();
  write(`m ${Date.now()} ${name}`);
}

/** Pass as a React `<Profiler onRender>` to count commits and render time (profiling builds only). */
export function onRender(_id: string, _phase: string, actualDuration: number): void {
  counters.commits++;
  counters.render += actualDuration;
}
