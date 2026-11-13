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

/** The device log's messages that contain `reply`, as they arrive. */
function follow(device: Device, reply: string, onMessage: (message: string) => void) {
  if (device.platform === 'android')
    return stream('adb', ['-s', device.id, 'logcat', '-v', 'raw', '-T', '1'], onMessage);
  const predicate = `eventMessage CONTAINS "${reply.replaceAll('"', '\\"')}"`;
  return stream(
    'xcrun',
    ['simctl', 'spawn', device.id, 'log', 'stream', '--style', 'ndjson', '--level', 'debug', '--predicate', predicate],
    (line) => {
      if (!line.startsWith('{')) return;
      const message = dig(JSON.parse(line), 'eventMessage');
      if (typeof message === 'string') onMessage(message);
    },
  );
}

async function call(config: BridgeConfig, device: Device, script: string): Promise<unknown> {
  const nonce = randomBytes(6).toString('hex');
  const collect = replyCollector(config.reply, nonce);
  const answer = Promise.withResolvers<unknown>();
  // Settled before it is awaited (a reply during the attach wait) must not read as unhandled.
  answer.promise.catch(() => undefined);
  const child = follow(device, config.reply, (message) => {
    try {
      const got = collect(message);
      if (got) answer.resolve(got.value);
    } catch (error) {
      answer.reject(error);
    }
  });
  const timer = setTimeout(
    () =>
      answer.reject(
        new Refusal('NoProbe', `no "${config.reply} ${nonce}" reply to "${script}" within ${REPLY_MS / 1000} s`),
      ),
    REPLY_MS,
  );
  try {
    await sleep(ATTACH_MS);
    await device.openUrl(config.link.replaceAll('{nonce}', nonce).replaceAll('{script}', encodeURIComponent(script)));
    const value = await answer.promise;
    if (dig(value, 'ok') === false)
      throw new Refusal('NoProbe', `the bridge failed "${script}": ${JSON.stringify(value).slice(0, 200)}`);
    return value;
  } finally {
    clearTimeout(timer);
    await stop(child);
  }
}

export function bridgeProbe(config: BridgeConfig, device: Device): ProbeSession {
  return {
    async begin() {
      await call(config, device, config.begin);
    },
    async read() {
      const reply = await call(config, device, config.read);
      return readProbe(config.parse ? config.parse(reply) : reply);
    },
    async stop() {},
  };
}
