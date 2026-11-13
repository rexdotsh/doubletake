import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { createServer } from 'node:http';
import { installProbe } from '../sdk/probe.ts';
import { validate } from '../src/bench.ts';
import { bridgeProbe, replyCollector } from '../src/bridge.ts';
import { cdpProbe, connect, pickTarget } from '../src/cdp.ts';
import { probeConfig, readProbe, typical } from '../src/probe.ts';
import { probeCard, probeText, waterfall } from '../src/probe-report.ts';
import { card, summary } from '../src/report.ts';
import type { Experiment } from '../src/store.ts';
import { dig } from '../src/util.ts';

afterEach(() => void setSystemTime());

type Fiber = {
  tag: number;
  flags: number;
  type: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
};

const fiber = (tag: number, type: unknown, flags = 0, child: Fiber | null = null, sibling: Fiber | null = null) => ({
  tag,
  type,
  flags,
  child,
  sibling,
  alternate: null as Fiber | null,
});

function App() {}
function Inner() {}
function Row2() {}
const Memo = { $$typeof: 'memo', type: Inner };
const Named = Object.assign(() => undefined, { displayName: 'Header' });

class FakeXhr {
  static last: FakeXhr | undefined;
  readyState = 0;
  status = 0;
  response: unknown = '';
  length: string | null = null;
  listeners = new Map<string, (() => void)[]>();
  open(_method: string, _url: string) {}
  send(_body?: unknown) {
    FakeXhr.last = this;
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  getResponseHeader(name: string) {
    return name === 'content-length' ? this.length : null;
  }
  fire(name: string) {
    for (const l of this.listeners.get(name) ?? []) l();
  }
  finish(status: number, response: unknown, length: string | null = null) {
    this.readyState = 2;
    this.fire('readystatechange');
    this.readyState = 4;
    this.status = status;
    this.response = response;
    this.length = length;
    this.fire('loadend');
  }
}

function app() {
  const commits: unknown[] = [];
  const hook = {
    renderers: new Map([[1, {}]]),
    onCommitFiberRoot: (...args: unknown[]) => void commits.push(args[1]),
  };
  return { g: { __REACT_DEVTOOLS_GLOBAL_HOOK__: hook, XMLHttpRequest: FakeXhr }, hook, commits };
}

function request(g: { XMLHttpRequest: typeof FakeXhr }, method: string, url: string, body?: unknown) {
  const x = new g.XMLHttpRequest();
  x.open(method, url);
  x.send(body);
  return x;
}

test('the probe counts commits and the components each one rendered, as DevTools walks them', () => {
  const { g, hook, commits } = app();
  const probe = installProbe(g);
  // Mount: App > [Header, Memo(Inner) > host]; nothing counted before begin().
  const host = fiber(5, 'View');
  const memo = fiber(14, Memo, 0, host);
  const header = fiber(0, Named, 0, null, memo);
  const app1 = fiber(0, App, 0, header);
  const root1 = fiber(3, null, 0, app1);
  hook.onCommitFiberRoot(1, { current: root1 });
  probe.begin();
  hook.onCommitFiberRoot(1, { current: root1 });
  // An update: App rendered, a new Row mounted, Header and Memo(Inner) bailed out (Memo keeps its old child).
  const row = fiber(1, Row2, 1);
  const memo2 = { ...fiber(14, Memo, 0, host), alternate: memo };
  const header2 = { ...fiber(0, Named, 0, null, memo2), alternate: header };
  const app2 = { ...fiber(0, App, 1, header2), alternate: app1 };
  header2.sibling = memo2;
  memo2.sibling = row;
  const root2 = { ...fiber(3, null, 0, app2), alternate: root1 };
  hook.onCommitFiberRoot(1, { current: root2 });
  // A commit whose root kept its child: nothing below rendered.
  hook.onCommitFiberRoot(1, { current: { ...fiber(3, null, 0, app2), alternate: { ...root2 } } });
  const read = probe.read(0, Date.now() + 1000);
  expect(commits).toHaveLength(4);
  expect(read.commits).toBe(3);
  expect(read.renderers).toBe(1);
  expect(read.components).toEqual([
    ['App', 2, 1],
    ['Header', 1, 1],
    ['Inner', 1, 1],
    ['Row2', 1, 1],
  ]);
  expect([read.renders, read.mounts]).toEqual([5, 4]);
  // Closed: later commits do not count, and reading again gives the same window.
  hook.onCommitFiberRoot(1, { current: root2 });
  expect(probe.read(0, Date.now() + 1000).commits).toBe(3);
});

test('the probe lists requests with hashes for query and body, timing and size', () => {
  const { g } = app();
  const probe = installProbe(g);
  request(g, 'get', 'https://api.example/v1/me').finish(200, 'x');
  probe.begin();
  request(g, 'get', 'https://api.example/v1/me').finish(200, '{"a":1}', '120');
  request(g, 'get', 'https://api.example/v1/me').finish(200, '{"a":1}', '120');
  request(g, 'get', 'https://api.example/v1/packs?page=2').finish(200, new Uint8Array(64));
  request(g, 'post', 'https://api.example/v1/buy', '{"id":1}');
  const read = probe.read();
  expect(read.requests.map((r) => [r.method, r.url, r.query !== '', r.body !== '', r.status, r.bytes])).toEqual([
    ['GET', 'https://api.example/v1/me', false, false, 200, 120],
    ['GET', 'https://api.example/v1/me', false, false, 200, 120],
    ['GET', 'https://api.example/v1/packs', true, false, 200, 64],
    ['POST', 'https://api.example/v1/buy', false, true, 0, 0],
  ]);
  expect(read.requests[0]?.end).toBeNumber();
  expect(read.requests[3]?.end).toBeUndefined();
  expect(read.network).toBe(true);
  const { detail, refused } = readProbe(read, { from: read.from, to: read.to });
  expect(detail).toMatchObject({ requests: 4, duplicates: 1, bytes: 304, commits: 0, overrun: 0 });
  expect(detail.keys?.[0]).toEqual({ key: 'GET https://api.example/v1/me', count: 2, bytes: 240 });
  expect(refused).toEqual({});
});

test('the probe runs from its source text alone, as CDP injects it, and installs once', () => {
  const g: Record<string, unknown> = { XMLHttpRequest: FakeXhr };
  // oxlint-disable-next-line typescript/no-implied-eval -- the point: the probe's text alone, as CDP sends it
  const install = new Function('g', `return (${installProbe.toString()})(g)`);
  install(g);
  expect(Reflect.get(g, '__REACT_DEVTOOLS_GLOBAL_HOOK__')).toBeObject();
  const again = installProbe(g);
  again.begin();
  const read = again.read();
  const { refused } = readProbe(read, { from: read.from, to: read.to });
  // A hook made after React started has no renderer: commits are refused, not zero.
  expect(refused['probe.commits']).toStartWith('NoRenderer');
  expect(refused['probe.requests']).toBeUndefined();
});

test('a bridge may give only aggregates; whatever is missing is refused', () => {
  const window = { from: 10_000, to: 11_200 };
  const { detail, refused } = readProbe(
    {
      requests: 5,
      duplicates: 2,
      bytes: 900,
      top: [{ key: 'GET /a', count: 3 }],
      commits: 7,
      renders: 40,
      renderers: 1,
      ms: 1250,
    },
    window,
  );
  expect(detail).toMatchObject({ ms: 1250, requests: 5, duplicates: 2, commits: 7, renders: 40, overrun: 50 });
  expect(detail.keys).toEqual([{ key: 'GET /a', count: 3, bytes: 0 }]);
  expect(refused).toEqual({});
  expect(readProbe({ requests: 2, renderers: 1, ms: 1200 }, window).refused['probe.renders']).toStartWith('NoProbe');
  // Zero commits without a renderer count cannot be told from a hook React never reached.
  const blind = readProbe({ ms: 1200, commits: 0, renders: 0, requests: 1, duplicates: 0, bytes: 1 }, window);
  expect(blind.refused['probe.commits']).toStartWith('NoRenderer: the app gave no renderer count');
  expect(blind.refused['probe.renders']).toStartWith('NoRenderer');
  expect([blind.detail.commits, blind.detail.renders, blind.detail.requests]).toEqual([undefined, undefined, 1]);
  expect(readProbe({ renderers: 0, ms: 1200 }, window).refused['probe.commits']).toStartWith('NoRenderer');
  expect(Object.keys(readProbe(null, window).refused)).toHaveLength(5);
  // No span to check against the window, or one too far off it: nothing is trusted.
  expect(readProbe({ requests: 2 }, window).refused['probe.requests']).toStartWith('NoWindow');
  const late = readProbe({ requests: 9, duplicates: 0, bytes: 1, commits: 1, renders: 1, ms: 2500 }, window);
  expect(Object.keys(late.refused)).toHaveLength(5);
  expect(late.refused['probe.requests']).toStartWith('WindowOverrun');
  expect(late.detail.requests).toBeUndefined();
});

const record = (extra: object) => ({
  schema: 'doubletake.probe.v1',
  from: 0,
  to: 1000,
  ms: 1000,
  renderers: 1,
  commits: 2,
  renders: 3,
  mounts: 0,
  components: [['A', 3, 0]],
  requests: [{ method: 'GET', url: '/a', query: '', body: '', status: 200, bytes: 5, start: 1, end: 9 }],
  network: true,
  dropped: 0,
  droppedCommits: 0,
  ...extra,
});

test("the probe's record is complete or refused: lists, entries, caps", () => {
  const window = { from: 0, to: 1000 };
  expect(readProbe(record({}), window).refused).toEqual({});
  const why = (extra: object, metric: string) => readProbe(record(extra), window).refused[metric] ?? '';
  expect(why({ network: false }, 'probe.bytes')).toStartWith('NoNetwork');
  expect(why({ requests: undefined }, 'probe.requests')).toStartWith('InvalidProbe: no request list');
  expect(why({ requests: [{ method: 'GET' }, { method: 'GET', url: '/', start: 0 }] }, 'probe.duplicates')).toStartWith(
    'InvalidProbe: 1 of 2',
  );
  expect(why({ dropped: 2 }, 'probe.requests')).toStartWith('Overflow');
  expect(why({ dropped: undefined }, 'probe.bytes')).toStartWith('Overflow');
  expect(why({ droppedCommits: 1 }, 'probe.renders')).toStartWith('Overflow');
  expect(why({ renderers: undefined }, 'probe.commits')).toStartWith('InvalidProbe');
  expect(why({ requests: [{ method: 'POST', url: '/', body: '?', start: 0 }] }, 'probe.duplicates')).toStartWith(
    'UnknownBody',
  );
  expect(why({ requests: [{ method: 'POST', url: '/', body: '?', start: 0 }] }, 'probe.requests')).toBe('');
  // Two finished POSTs without fingerprints or sizes are not one duplicate and zero bytes.
  const bare = { method: 'POST', url: '/', status: 200, start: 0, end: 5 };
  const twice = readProbe(record({ requests: [bare, bare] }), window);
  expect(twice.refused['probe.duplicates']).toStartWith('InvalidProbe: 2 requests without query and body');
  expect(twice.refused['probe.bytes']).toStartWith('InvalidProbe: 2 requests without a size');
  expect(twice.refused['probe.requests']).toBeUndefined();
  expect([twice.detail.duplicates, twice.detail.bytes, twice.detail.keys, twice.detail.requests]).toEqual([
    undefined,
    undefined,
    undefined,
    2,
  ]);
});

test('the probe counts only what happened inside the window it is asked for', () => {
  const { g, hook } = app();
  const probe = installProbe(g);
  setSystemTime(new Date(1000));
  probe.begin();
  request(g, 'get', '/before').finish(200, 'x');
  hook.onCommitFiberRoot(1, { current: fiber(3, null, 0, fiber(0, App)) });
  setSystemTime(new Date(2000));
  const inside = request(g, 'get', '/inside');
  hook.onCommitFiberRoot(1, { current: fiber(3, null, 0, fiber(0, App)) });
  setSystemTime(new Date(2500));
  request(g, 'get', '/done').finish(200, 'é€😀');
  setSystemTime(new Date(3500));
  inside.finish(200, 'late');
  request(g, 'get', '/after');
  hook.onCommitFiberRoot(1, { current: fiber(3, null, 0, fiber(0, App)) });
  const read = probe.read(2000, 3000);
  expect([read.from, read.to, read.ms, read.commits, read.renders]).toEqual([2000, 3000, 1000, 1, 1]);
  expect(read.requests).toEqual([
    {
      method: 'GET',
      url: '/inside',
      query: '',
      body: '',
      status: 0,
      bytes: 0,
      start: 0,
      headers: undefined,
      end: undefined,
    },
    // UTF-8: é 2 bytes, € 3, 😀 4.
    { method: 'GET', url: '/done', query: '', body: '', status: 200, bytes: 9, start: 500, headers: 500, end: 500 },
  ]);
});

const formData = (parts: unknown[]) => ({ getParts: () => parts });

test('request bodies are told apart by content; one the probe cannot read refuses duplicates', () => {
  const { g } = app();
  const probe = installProbe(g);
  probe.begin();
  for (const body of [
    new Uint8Array([1, 2]),
    new Uint8Array([1, 3]),
    new Uint8Array([9, 1, 3]).subarray(1),
    new Uint8Array([1, 2]).buffer,
    formData([{ string: 'a' }]),
    formData([{ string: 'b' }]),
  ])
    request(g, 'post', '/upload', body).finish(200, '');
  const read = probe.read(0, Date.now() + 1);
  expect(read.requests.map((r) => r.body)).toEqual([
    expect.stringMatching(/^2\./),
    expect.stringMatching(/^2\./),
    read.requests[1]?.body,
    read.requests[0]?.body,
    expect.any(String),
    expect.any(String),
  ]);
  expect(new Set(read.requests.map((r) => r.body)).size).toBe(4);
  expect(readProbe(read, { from: read.from, to: read.to }).detail.duplicates).toBe(2);
  request(g, 'post', '/upload', { size: 3 });
  probe.begin();
  request(g, 'post', '/upload', { size: 3 }).finish(200, '');
  request(g, 'post', '/upload', { size: 4 }).finish(200, '');
  const blobs = probe.read(0, Date.now() + 1);
  expect(blobs.requests.map((r) => r.body)).toEqual(['?', '?']);
  expect(readProbe(blobs, { from: blobs.from, to: blobs.to }).refused['probe.duplicates']).toStartWith('UnknownBody');
});

test('a bridge keeps one log follower for its session and reads the window it is given', async () => {
  let follows = 0;
  let deliver: ((message: string) => void) | undefined;
  const opened: string[] = [];
  const device = {
    platform: 'android' as const,
    id: 'emu',
    async openUrl(url: string) {
      opened.push(url);
      const query = new URL(url).searchParams;
      const script = query.get('c') ?? '';
      const reply = script.startsWith('read')
        ? {
            ok: true,
            steps: [
              { value: { requests: 1, duplicates: 0, bytes: 2, commits: 3, renders: 4, renderers: 1, ms: 1000 } },
            ],
          }
        : { ok: true };
      queueMicrotask(() => deliver?.(`I ReactNativeJS: [APP] ${query.get('n')} 1/1 ${JSON.stringify(reply)}`));
    },
  };
  const bridge = bridgeProbe(
    {
      link: 'app://lab?n={nonce}&c={script}',
      reply: '[APP]',
      begin: 'begin',
      read: 'read {from} {to}',
      parse: (r) => dig(r, 'steps', 0, 'value'),
    },
    device,
    (_device, _reply, onMessage) => {
      follows++;
      deliver = onMessage;
      return async () => {};
    },
  );
  await bridge.begin();
  const started = Date.now();
  const { detail, refused } = await bridge.read({ from: 5000, to: 6000 });
  expect(Date.now() - started).toBeLessThan(500);
  expect(follows).toBe(1);
  expect(decodeURIComponent(opened[1] ?? '')).toContain('read 5000 6000');
  expect(detail).toMatchObject({ requests: 1, commits: 3, overrun: 0 });
  expect(refused).toEqual({});
  await bridge.begin();
  expect(follows).toBe(1);
  await bridge.stop();
});

test('a bridge reply is put together from its chunks, in any order', () => {
  const collect = replyCollector('[APP]', 'n1');
  expect(collect('I ReactNativeJS: [APP] n1 2/2 :1}')).toBeUndefined();
  expect(collect('[APP] n2 1/1 {}')).toBeUndefined();
  expect(collect('[APP] n1 1/2 {"a"')).toEqual({ done: true, value: { a: 1 } });
  expect(() => replyCollector('[APP]', 'x')('[APP] x 1/1 {oops')).toThrow('not JSON');
});

const page = (appId: string, deviceName: string, url: string, logical = deviceName) => ({
  appId,
  deviceName,
  webSocketDebuggerUrl: url,
  reactNative: { logicalDeviceId: logical },
});

test('the CDP target is exactly the app, on exactly this device, and only one', () => {
  const emulator = 'sdk_phone (emulator)';
  expect(pickTarget([page('com.app', 'sdk_phone - 16 - API 36', 'ws://1')], 'com.app', emulator)).toEqual({
    url: 'ws://1',
  });
  // Another app whose id starts with this one's is not it.
  expect(pickTarget([page('com.app.preview', 'sdk_phone - 16 - API 36', 'ws://p')], 'com.app', emulator)).toEqual({
    refusal: 'no runtime of com.app (1 listed)',
  });
  // The app on another device only.
  expect(pickTarget([page('com.app', 'Pixel 9 - 16 - API 36', 'ws://o')], 'com.app', emulator)).toEqual({
    refusal: 'com.app runs on Pixel 9 - 16 - API 36, not sdk_phone (emulator)',
  });
  // Two emulators of one model: refused, never the last one listed.
  const two = [
    page('com.app', 'sdk_phone - 16 - API 36', 'ws://a', 'a'),
    page('com.app', 'sdk_phone - 16 - API 36', 'ws://b', 'b'),
  ];
  expect(pickTarget(two, 'com.app', emulator)).toEqual({
    refusal: '2 devices run com.app as sdk_phone (emulator): stop the others or use one Metro per device',
  });
  // One device listing a legacy page beside the current one: the current one.
  const legacy = { description: 'com.app', deviceName: 'iPhone 17', webSocketDebuggerUrl: 'ws://legacy' };
  expect(pickTarget([page('com.app', 'iPhone 17', 'ws://new'), legacy], 'com.app', 'iPhone 17')).toEqual({
    url: 'ws://new',
  });
  expect(pickTarget({}, 'x', 'y')).toEqual({ refusal: "Metro's /json/list is not a list" });
  // A runtime Metro names no device for cannot be checked: refused, even when it is the only one.
  expect(pickTarget([{ appId: 'com.app', webSocketDebuggerUrl: 'ws://u' }], 'com.app', emulator)).toEqual({
    refusal: "Metro names no device for com.app's runtime, so it cannot be told to be sdk_phone (emulator)'s",
  });
});

const failed = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (error: unknown) => String(error),
  );

test('CDP gives up on a Metro or a runtime that never answers, by its deadlines', async () => {
  const server = createServer(() => {});
  server.on('upgrade', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const d = { find: 400, fetch: 100, connect: 200, call: 200 };
  try {
    let started = Date.now();
    expect(await failed(connect(`ws://127.0.0.1:${port}/x`, d))).toContain('no handshake within 0.2 s');
    expect(Date.now() - started).toBeLessThan(1500);
    started = Date.now();
    expect(await failed(cdpProbe(`http://127.0.0.1:${port}`, 'com.app', 'emu', d).begin())).toContain(
      'no runtime to probe',
    );
    expect(Date.now() - started).toBeLessThan(2500);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('bench files declare where probe metrics come from', () => {
  const idle = { idle: '5s', primary: 'probe.renders' };
  expect(() => validate({ cases: { a: idle } })).toThrow("need the bench's probe");
  expect(() =>
    validate({ probe: { cdp: 'http://localhost:8081' }, cases: { a: { launch: {}, primary: 'probe.requests' } } }),
  ).toThrow('for run and idle cases');
  expect(validate({ probe: { cdp: 'http://localhost:8081/' }, cases: { a: idle } }).probe).toEqual({
    cdp: 'http://localhost:8081',
  });
  expect(() => probeConfig({ cdp: 'localhost' })).toThrow("Metro's URL");
  expect(() => probeConfig({ bridge: { link: 'x://lab', reply: 'R', begin: 'b', read: 'r' } })).toThrow('{nonce}');
  const parsed = probeConfig({
    bridge: { link: 'x://lab?n={nonce}&c={script}', reply: 'R', begin: 'b', read: 'r', parse: (r: unknown) => [r] },
  });
  expect('bridge' in parsed && parsed.bridge.parse?.(1)).toEqual([1]);
});

const experiment = (probe: Experiment['series'][number]['probe']): Experiment => ({
  schema: 'doubletake.experiment.v1',
  id: 'exp_probe',
  kind: 'experiment',
  created: '2026-01-01T00:00:00Z',
  file: 'app.bench.ts',
  comparison: 'builds',
  device: { platform: 'android', name: 'emulator', os: '16', id: 'emulator-5554', host: '' },
  variants: [],
  plan: { pairs: 8, runs: 3, warmup_runs: 1, warmup_blocks: 1, order: 'ABBA', install: 'sequential' },
  decided: false,
  series: [
    {
      case: 'feed',
      primary: {
        metric: 'probe.renders',
        n: 8,
        base: 120,
        head: 60,
        estimate: -60,
        lo: -60,
        hi: -60,
        relative: false,
        confidence: 0.95,
        p: 0.01,
        bound: 0,
        better: 'lower',
        verdict_kind: 'better',
        decided: true,
        needed_pairs: null,
        exact: true,
      },
      secondaries: [],
      refused: {},
      probe,
      pairs: 8,
      stopped: 'decided at 8 pairs',
      minutes: 3,
    },
  ],
  checks: [],
  warnings: [],
});

test('reports show re-renders, duplicates and the waterfall per case', () => {
  const base = {
    ms: 2000,
    commits: 10,
    renders: 120,
    mounts: 20,
    components: [
      { name: 'Row', renders: 90, mounts: 10 },
      { name: 'Feed', renders: 30, mounts: 10 },
    ],
    requests: 3,
    duplicates: 1,
    bytes: 3072,
    keys: [{ key: 'GET /feed', count: 2, bytes: 2048 }],
    waterfall: [
      { method: 'GET', url: '/feed', query: '', body: '', status: 200, bytes: 1024, start: 0, end: 500 },
      { method: 'GET', url: '/feed', query: '', body: '', status: 200, bytes: 1024, start: 1000, end: 2000 },
      { method: 'GET', url: '/me', query: 'k1', body: '', status: 0, bytes: 1024, start: 1500 },
    ],
  };
  const head = {
    ...base,
    renders: 60,
    components: [{ name: 'Row', renders: 30, mounts: 10 }],
    duplicates: 0,
    keys: [],
  };
  const text = probeText(experiment({ base, head })).join('\n');
  expect(text).toContain('commits 10 → 10 · renders 120 → 60 · mounts 20 → 20 · requests 3 → 3 · duplicates 1 → 0');
  expect(text).toContain('re-rendering (base): Row 80 (+10 mounts), Feed 20 (+10 mounts)');
  expect(text).toContain('duplicate requests (base): GET /feed ×2 (2.0 KiB)');
  expect(text).toContain('renders changed: Row 90 → 30 (\u221260), Feed 30 → 0 (\u221230)');
  expect(summary(experiment({ base, head }))).toContain('renders and requests (app probe');
  const md = card(experiment({ base, head }));
  expect(md).toContain('| feed | 10 → 10 | 120 → 60 | 3 → 3 | 1 → 0 | 3.0 KiB → 3.0 KiB |');
  expect(probeCard(experiment(undefined))).toEqual([]);
  expect(waterfall(base.waterfall, 2000)).toEqual([
    `▕${'█'.repeat(9).padEnd(32)}▏     +0   500 ms  200   1.0 KiB  GET /feed`,
    `▕${' '.repeat(16)}${'█'.repeat(16)}▏  +1000  1000 ms  200   1.0 KiB  GET /feed`,
    `▕${' '.repeat(24)}${'…'.repeat(8)}▏  +1500     open    —   1.0 KiB  GET /me?#k1`,
  ]);
  expect(typical([head, base, { ...base, renders: 200 }])).toBe(base);
});
