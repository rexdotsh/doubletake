import { installProbe } from '../sdk/probe.ts';
import { Refusal } from './device.ts';
import type { ProbeSession } from './probe.ts';
import { readProbe } from './probe.ts';
import { sleep } from './sh.ts';
import { isRecord } from './util.ts';

// The probe over CDP, for dev clients: Metro's inspector proxy lists the app's JS runtimes, and the probe goes
// in with Runtime.evaluate. A dev build's React reports to DevTools' hook, which the probe wraps at any time.

type Target = { url: string; appId: string };

/** How long a just-launched app may take to show up in Metro's list. */
const FIND_MS = 20_000;
const CALL_MS = 15_000;

/** The newest debuggable runtime of `appId` in Metro's `/json/list`. */
export function pickTarget(list: unknown, appId: string): string | undefined {
  if (!Array.isArray(list)) return undefined;
  const targets: Target[] = list.filter(isRecord).flatMap((t) => {
    const url = t.webSocketDebuggerUrl;
    if (typeof url !== 'string') return [];
    const id = [t.appId, t.description, t.title].find((v): v is string => typeof v === 'string' && v.includes(appId));
    return id === undefined ? [] : [{ url, appId: id }];
  });
  return targets.at(-1)?.url;
}

async function find(metro: string, appId: string): Promise<string> {
  const end = Date.now() + FIND_MS;
  let seen = 'nothing';
  for (;;) {
    const list: unknown = await fetch(`${metro}/json/list`)
      .then((r) => r.json())
      .catch((error: unknown) => {
        seen = error instanceof Error ? error.message : String(error);
        return [];
      });
    const url = pickTarget(list, appId);
    if (url) return url;
    if (Array.isArray(list)) seen = `${list.length} runtime(s), none of ${appId}`;
    if (Date.now() > end)
      throw new Refusal('NoProbe', `no ${appId} runtime on Metro at ${metro} within ${FIND_MS / 1000} s (${seen})`);
    await sleep(500);
  }
}

type Socket = { evaluate(expression: string): Promise<unknown>; close(): void };

async function connect(url: string): Promise<Socket> {
  const ws = new WebSocket(url);
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let next = 0;
  ws.addEventListener('message', (event) => {
    const message: unknown = typeof event.data === 'string' ? JSON.parse(event.data) : undefined;
    if (isRecord(message) && typeof message.id === 'number') pending.get(message.id)?.(message);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Refusal('NoProbe', `cannot connect to ${url}`)));
  });
  const call = (method: string, params: object) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Refusal('NoProbe', `${method} got no answer within ${CALL_MS / 1000} s`));
      }, CALL_MS);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(message);
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
const READ = `JSON.stringify(globalThis.__doubletake_probe__ ? globalThis.__doubletake_probe__.read() : null)`;

export function cdpProbe(metro: string, appId: string): ProbeSession {
  let socket: Socket | undefined;
  return {
    async begin() {
      socket?.close();
      // The runtime changes with every launch: find it for each window.
      socket = await connect(await find(metro, appId));
      await socket.evaluate(INSTALL);
    },
    async read() {
      if (!socket) throw new Error('probe read before begin');
      const text = await socket.evaluate(READ);
      socket.close();
      socket = undefined;
      return readProbe(typeof text === 'string' ? JSON.parse(text) : undefined);
    },
    async stop() {
      socket?.close();
      socket = undefined;
    },
  };
}
