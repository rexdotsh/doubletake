import { expect, test } from 'bun:test';
import { installProbe } from '../sdk/probe.ts';
import { validate } from '../src/bench.ts';
import { replyCollector } from '../src/bridge.ts';
import { pickTarget } from '../src/cdp.ts';
import { probeConfig, readProbe, typical } from '../src/probe.ts';
import { probeCard, probeText, waterfall } from '../src/probe-report.ts';
import { card, summary } from '../src/report.ts';
import type { Experiment } from '../src/store.ts';

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
  const read = probe.read();
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
  expect(probe.read().commits).toBe(3);
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
  const { detail, refused } = readProbe(read);
  expect(detail).toMatchObject({ requests: 4, duplicates: 1, bytes: 304, commits: 0 });
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
  const { refused } = readProbe(again.read());
  // A hook made after React started has no renderer: commits are refused, not zero.
  expect(refused['probe.commits']).toStartWith('NoRenderer');
  expect(refused['probe.requests']).toBeUndefined();
});

test('a bridge may give only aggregates; whatever is missing is refused', () => {
  const { detail, refused } = readProbe({
    requests: 5,
    duplicates: 2,
    bytes: 900,
    top: [{ key: 'GET /a', count: 3 }],
    commits: 7,
    renders: 40,
    ms: 1200,
  });
  expect(detail).toMatchObject({ ms: 1200, requests: 5, duplicates: 2, commits: 7, renders: 40 });
  expect(detail.keys).toEqual([{ key: 'GET /a', count: 3, bytes: 0 }]);
  expect(refused).toEqual({});
  expect(readProbe({ requests: 2 }).refused['probe.renders']).toStartWith('NoProbe');
  expect(readProbe({ commits: 0, renders: 0, renderers: 0 }).refused['probe.commits']).toStartWith('NoRenderer');
  expect(Object.keys(readProbe(null).refused)).toHaveLength(5);
  expect(readProbe({ schema: 'doubletake.probe.v1', renderers: 1, network: false }).refused['probe.bytes']).toStartWith(
    'NoNetwork',
  );
});

test('a bridge reply is put together from its chunks, in any order', () => {
  const collect = replyCollector('[APP]', 'n1');
  expect(collect('I ReactNativeJS: [APP] n1 2/2 :1}')).toBeUndefined();
  expect(collect('[APP] n2 1/1 {}')).toBeUndefined();
  expect(collect('[APP] n1 1/2 {"a"')).toEqual({ done: true, value: { a: 1 } });
  expect(() => replyCollector('[APP]', 'x')('[APP] x 1/1 {oops')).toThrow('not JSON');
});

test('the newest runtime of the app is the CDP target', () => {
  const list = [
    { appId: 'com.example.app', webSocketDebuggerUrl: 'ws://old' },
    { description: 'com.other', webSocketDebuggerUrl: 'ws://other' },
    { description: 'com.example.app', webSocketDebuggerUrl: 'ws://new' },
    { appId: 'com.example.app' },
  ];
  expect(pickTarget(list, 'com.example.app')).toBe('ws://new');
  expect(pickTarget(list, 'com.none')).toBeUndefined();
  expect(pickTarget({}, 'x')).toBeUndefined();
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
