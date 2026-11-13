import { installProbe } from '../sdk/probe.ts';
import { Refusal } from './device.ts';
import type { ProbeSession } from './probe.ts';
import { readProbe } from './probe.ts';
import { sleep } from './sh.ts';
import { isRecord } from './util.ts';

// The probe over CDP, for dev clients: Metro's inspector proxy lists the app's JS runtimes, and the probe goes
// in with Runtime.evaluate. A dev build's React reports to DevTools' hook, which the probe wraps at any time.

/** Every step has a deadline: a just-launched app may take this long to show up in Metro's list. */
export type Deadlines = { find: number; fetch: number; connect: number; call: number };
const DEADLINES: Deadlines = { find: 20_000, fetch: 5000, connect: 10_000, call: 15_000 };

/**
 * Metro's name for `device`: Android lists the model (`<model> - <release> - API <n>`), iOS the simulator's name.
 * Ours is the model or the simulator's name, with ` (emulator)` after an emulator's model.
 */
const sameDevice = (listed: string, device: string) => {
  const base = device.replace(/ \(emulator\)$/, '');
  return listed === base || listed.startsWith(`${base} - `);
};

/**
 * Which device a page is on: Metro's own device id from its debugger URL (`?device=…&page=…`), the same for a
 * device's legacy and current pages; else the page's logical device id; else the page alone (never merged).
 */
function deviceOf(t: Record<string, unknown>): string {
  const device = /[?&]device=([^&]+)/.exec(String(t.webSocketDebuggerUrl))?.[1];
  if (device) return `device:${decodeURIComponent(device)}`;
  const logical = isRecord(t.reactNative) ? t.reactNative.logicalDeviceId : undefined;
  return logical === undefined
    ? `page:${JSON.stringify(t.id ?? t.webSocketDebuggerUrl)}`
    : `logical:${JSON.stringify(logical)}`;
}

/**
 * The runtime of exactly `appId` on `device` in Metro's `/json/list`, or why there is none to trust: another
 * device's runtime of the same app, or two devices' runtimes, would measure the wrong app.
 */
export function pickTarget(list: unknown, appId: string, device: string): { url: string } | { refusal: string } {
  if (!Array.isArray(list)) return { refusal: "Metro's /json/list is not a list" };
  const mine = list.filter(isRecord).filter((t) => t.appId === appId || t.description === appId);
  const withUrl = mine.filter((t) => typeof t.webSocketDebuggerUrl === 'string');
  const named = withUrl.filter((t) => typeof t.deviceName === 'string');
  const here = named.filter((t) => sameDevice(String(t.deviceName), device));
  if (!withUrl.length) return { refusal: `no runtime of ${appId} (${list.length} listed)` };
  if (!named.length)
    return { refusal: `Metro names no device for ${appId}'s runtime, so it cannot be told to be ${device}'s` };
  if (!here.length)
    return {
      refusal: `${appId} runs on ${[...new Set(named.map((t) => String(t.deviceName)))].join(', ')}, not ${device}`,
    };
  // Every page counts, legacy ones too: a legacy page merges with a current one only when both are on one device.
  const devices = new Set(here.map(deviceOf));
  if (devices.size > 1)
    return {
      refusal: `${devices.size} devices run ${appId} as ${device}: stop the others or use one Metro per device`,
    };
  // One device can list a legacy page beside the current one: the current one carries `reactNative`.
  const modern = here.filter((t) => isRecord(t.reactNative));
  return { url: String((modern.length ? modern : here).at(-1)?.webSocketDebuggerUrl) };
}

async function find(metro: string, appId: string, device: string, d: Deadlines): Promise<string> {
  const end = Date.now() + d.find;
  for (;;) {
    let why: string;
    try {
      const response = await fetch(`${metro}/json/list`, { signal: AbortSignal.timeout(d.fetch) });
      const picked = pickTarget(await response.json(), appId, device);
      if ('url' in picked) return picked.url;
      why = picked.refusal;
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() + 500 > end)
      throw new Refusal('NoProbe', `no runtime to probe on Metro at ${metro} within ${d.find / 1000} s: ${why}`);
    await sleep(500);
  }
}

type Socket = { evaluate(expression: string): Promise<unknown>; close(): void };

export async function connect(url: string, d: Deadlines = DEADLINES): Promise<Socket> {
  const ws = new WebSocket(url);
  const pending = new Map<number, { resolve(m: Record<string, unknown>): void; reject(e: Error): void }>();
  let next = 0;
  ws.addEventListener('message', (event) => {
    const message: unknown = typeof event.data === 'string' ? JSON.parse(event.data) : undefined;
    if (isRecord(message) && typeof message.id === 'number') pending.get(message.id)?.resolve(message);
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.reject(new Refusal('NoProbe', `the app's runtime closed ${url}`));
    pending.clear();
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (why: string) => {
      clearTimeout(timer);
      ws.close();
      reject(new Refusal('NoProbe', `cannot connect to ${url}: ${why}`));
    };
    const timer = setTimeout(() => fail(`no handshake within ${d.connect / 1000} s`), d.connect);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => fail('connection error'));
    ws.addEventListener('close', () => fail('closed'));
  });
  const call = (method: string, params: object) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Refusal('NoProbe', `${method} got no answer within ${d.call / 1000} s`));
      }, d.call);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    async evaluate(expression) {
      const answer = await call('Runtime.evaluate', { expression, returnByValue: true, silent: true });
      const result = answer.result;
      const error = answer.error ?? (isRecord(result) ? result.exceptionDetails : undefined);
      if (error !== undefined || !isRecord(result) || !isRecord(result.result))
        throw new Error(`Runtime.evaluate failed in the app: ${JSON.stringify(error ?? answer).slice(0, 300)}`);
      return result.result.value;
    },
    close: () => ws.close(),
  };
}

// The probe's source as one expression; JSON keeps the reply a plain string through any CDP serializer.
const INSTALL = `(${installProbe.toString()})(globalThis).begin()`;
const read = (from: number, to: number) =>
  `JSON.stringify(globalThis.__doubletake_probe__ ? globalThis.__doubletake_probe__.read(${from}, ${to}) : null)`;

export function cdpProbe(metro: string, appId: string, device: string, d: Deadlines = DEADLINES): ProbeSession {
  let socket: Socket | undefined;
  return {
    async begin() {
      socket?.close();
      // The runtime changes with every launch: find it for each window.
      socket = await connect(await find(metro, appId, device, d), d);
      await socket.evaluate(INSTALL);
    },
    async read(window) {
      if (!socket) throw new Error('probe read before begin');
      try {
        const text = await socket.evaluate(read(Math.round(window.from), Math.round(window.to)));
        return readProbe(typeof text === 'string' ? JSON.parse(text) : undefined, window);
      } finally {
        socket.close();
        socket = undefined;
      }
    },
    async stop() {
      socket?.close();
      socket = undefined;
    },
  };
}
