import { randomBytes } from 'node:crypto';
import type { Device } from './device.ts';
import { Refusal } from './device.ts';
import type { BridgeConfig, ProbeSession } from './probe.ts';
import { readProbe } from './probe.ts';
import { sleep, stop, stream } from './sh.ts';
import { dig } from './util.ts';

// The probe through a bridge the app exposes, for any build: a deep link carries a script, and the app answers
// in its log, `<reply> <nonce> <i>/<n> <json chunk>` (chunked, since loggers cut long lines).

const REPLY_MS = 30_000;
// A log stream misses lines written before it attaches.
const ATTACH_MS = 1000;

/** Collects one nonce's reply chunks; returns the parsed JSON once every chunk is in. */
export function replyCollector(
  reply: string,
  nonce: string,
): (message: string) => { done: true; value: unknown } | undefined {
  const tag = `${reply} ${nonce} `;
  const chunks = new Map<number, string>();
  return (message) => {
    const at = message.indexOf(tag);
    const m = at < 0 ? null : /^(\d+)\/(\d+) (.*)$/.exec(message.slice(at + tag.length).replace(/\r$/, ''));
    if (!m) return undefined;
    const total = Number(m[2]);
    chunks.set(Number(m[1]), m[3] ?? '');
    if (chunks.size < total) return undefined;
    const text = Array.from({ length: total }, (_, i) => chunks.get(i + 1) ?? '').join('');
    try {
      return { done: true, value: JSON.parse(text) };
    } catch {
      throw new Refusal('NoProbe', `the bridge's reply is not JSON: ${text.slice(0, 120)}`);
    }
  };
}

/** Streams the device log's messages that contain `reply`; returns its stop. */
type BridgeDevice = Pick<Device, 'platform' | 'id' | 'openUrl'>;

export type Follow = (device: BridgeDevice, reply: string, onMessage: (message: string) => void) => () => Promise<void>;

const followLog: Follow = (device, reply, onMessage) => {
  if (device.platform === 'android') {
    const child = stream('adb', ['-s', device.id, 'logcat', '-v', 'raw', '-T', '1'], onMessage);
    return () => stop(child);
  }
  const predicate = `eventMessage CONTAINS "${reply.replaceAll('"', '\\"')}"`;
  const child = stream(
    'xcrun',
    ['simctl', 'spawn', device.id, 'log', 'stream', '--style', 'ndjson', '--level', 'debug', '--predicate', predicate],
    (line) => {
      if (!line.startsWith('{')) return;
      const message = dig(JSON.parse(line), 'eventMessage');
      if (typeof message === 'string') onMessage(message);
    },
  );
  return () => stop(child);
};

/**
 * A bridge session: one log follower, attached at the first `begin` (before any window) and kept until `stop`,
 * so a read goes out the moment the window ends. A `read` script with `{from}` and `{to}` gets the window's
 * device-clock bounds and counts exactly it; otherwise the reply's span is checked against the window.
 */
export function bridgeProbe(config: BridgeConfig, device: BridgeDevice, follow: Follow = followLog): ProbeSession {
  const listeners = new Set<(message: string) => void>();
  let stopLog: (() => Promise<void>) | undefined;

  const call = async (script: string): Promise<unknown> => {
    if (!stopLog) {
      stopLog = follow(device, config.reply, (message) => {
        for (const listen of listeners) listen(message);
      });
      await sleep(ATTACH_MS);
    }
    const nonce = randomBytes(6).toString('hex');
    const collect = replyCollector(config.reply, nonce);
    const answer = Promise.withResolvers<unknown>();
    // Settled before it is awaited must not read as unhandled.
    answer.promise.catch(() => undefined);
    const listen = (message: string) => {
      try {
        const got = collect(message);
        if (got) answer.resolve(got.value);
      } catch (error) {
        answer.reject(error);
      }
    };
    listeners.add(listen);
    const timer = setTimeout(
      () =>
        answer.reject(
          new Refusal('NoProbe', `no "${config.reply} ${nonce}" reply to "${script}" within ${REPLY_MS / 1000} s`),
        ),
      REPLY_MS,
    );
    try {
      await device.openUrl(config.link.replaceAll('{nonce}', nonce).replaceAll('{script}', encodeURIComponent(script)));
      const value = await answer.promise;
      if (dig(value, 'ok') === false)
        throw new Refusal('NoProbe', `the bridge failed "${script}": ${JSON.stringify(value).slice(0, 200)}`);
      return value;
    } finally {
      clearTimeout(timer);
      listeners.delete(listen);
    }
  };

  return {
    async begin() {
      await call(config.begin);
    },
    async read(window) {
      const script = config.read
        .replaceAll('{from}', String(Math.round(window.from)))
        .replaceAll('{to}', String(Math.round(window.to)));
      const reply = await call(script);
      return readProbe(config.parse ? config.parse(reply) : reply, window);
    },
    async stop() {
      await stopLog?.();
      stopLog = undefined;
    },
  };
}
