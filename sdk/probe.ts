// What a screen does inside the app, per window: React commits and the components each one rendered (through
// React's DevTools hook), and every XMLHttpRequest (so fetch) with its timing and size. The host starts counting
// with begin() and reads with read(from, to): only what happened between those two device-clock times, so a read
// that arrives late (a deep link's latency) still counts the measured window alone.
//
// installProbe is injected as source text: everything it uses lives inside it, and only what Hermes runs.

/**
 * One request: method and URL without its query; query and body as short hashes (`?`: a body the probe cannot
 * fingerprint, `''`: none). Times are ms from the window's start.
 */
export type ProbeRequest = {
  method: string;
  url: string;
  query: string;
  body: string;
  status: number;
  /** Content-Length, else the body's UTF-8 size. */
  bytes: number;
  start: number;
  /** Headers received. */
  headers?: number;
  /** Finished (loaded, failed or aborted); absent while in flight. */
  end?: number;
};

export type ProbeRead = {
  schema: 'doubletake.probe.v1';
  /** The window counted, device clock (ms since the epoch). */
  from: number;
  to: number;
  ms: number;
  /** When counting began. */
  begun: number;
  /** React renderers attached to the hook: 0 means React loaded before the hook and no commit is seen. */
  renderers: number;
  commits: number;
  /** Component renders (function, class, forwardRef and memo components), mounts included. */
  renders: number;
  mounts: number;
  /** [name, renders, mounts], most renders first. */
  components: [string, number, number][];
  requests: ProbeRequest[];
  /** Whether XMLHttpRequest was there to watch. */
  network: boolean;
  /** Requests and commits past the caps since begin(), not kept: the totals would be short. */
  dropped: number;
  droppedCommits: number;
};

export type Probe = { begin(): void; read(from?: number, to?: number): ProbeRead };

/**
 * Installs the probe on `g` once and returns it (also as `g.__doubletake_probe__`). In a release build, call it
 * before React loads (first in the app's entry file): React attaches to a DevTools hook only when it starts.
 */
export function installProbe(g: object): Probe {
  const KEY = '__doubletake_probe__';
  const present: unknown = Reflect.get(g, KEY);
  if (typeof present === 'object' && present !== null && 'read' in present && 'begin' in present) {
    const begin: unknown = Reflect.get(present, 'begin');
    const read: unknown = Reflect.get(present, 'read');
    if (typeof begin === 'function' && typeof read === 'function')
      return {
        begin: () => void Reflect.apply(begin, present, []),
        read: (from, to) => Reflect.apply(read, present, [from, to]),
      };
  }
  type Fiber = { tag: number; flags?: number; type?: unknown };
  /** A request with absolute times. */
  type Entry = Omit<ProbeRequest, 'start' | 'headers' | 'end'> & { start: number; headers?: number; end?: number };
  const MAX_REQUESTS = 2000;
  const MAX_COMMITS = 5000;
  const MAX_COMPONENTS = 60;
  // Function, class, forwardRef, memo and simple memo components; PerformedWork marks the ones that rendered.
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  const PERFORMED_WORK = 1;

  let on = false;
  let begun = Date.now();
  let dropped = 0;
  let droppedCommits = 0;
  // Per commit: when, and [name, renders, mounts] for each component it rendered.
  let commits: [number, [string, number, number][]][] = [];
  let requests: Entry[] = [];

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- injected as source: it all stays inside
  const isObject = (v: unknown): v is object => (typeof v === 'object' && v !== null) || typeof v === 'function';
  const isFiber = (v: unknown): v is Fiber => isObject(v) && typeof Reflect.get(v, 'tag') === 'number';
  const fiberAt = (v: unknown, key: string): Fiber | null => {
    const next: unknown = isObject(v) ? Reflect.get(v, key) : null;
    return isFiber(next) ? next : null;
  };
  // FNV-1a over 16-bit code units or bytes.
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- injected as source: it all stays inside
  const hash = (length: number, at: (i: number) => number) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < length; i++) h = Math.imul(h ^ at(i), 0x01000193) >>> 0;
    return h.toString(36);
  };
  const hashText = (text: string) => hash(text.length, (i) => text.charCodeAt(i));
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- injected as source: it all stays inside
  const utf8 = (text: string) => {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        n += next >= 0xdc00 && next < 0xe000 ? 4 : 3;
        if (next >= 0xdc00 && next < 0xe000) i++;
      } else n += 3;
    }
    return n;
  };
  // A body's identity: text and bytes are hashed, React Native's FormData by its parts; anything else is `?`.
  const bodyOf = (body: unknown): string => {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return hashText(body);
    const view =
      body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : ArrayBuffer.isView(body)
          ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
          : undefined;
    if (view) return `${view.length}.${hash(view.length, (i) => view[i] ?? 0)}`;
    const parts: unknown = isObject(body) ? Reflect.get(body, 'getParts') : undefined;
    if (typeof parts === 'function') {
      try {
        return hashText(JSON.stringify(Reflect.apply(parts, body, [])));
      } catch {
        return '?';
      }
    }
    return '?';
  };
  const nameOf = (type: unknown, depth: number): string => {
    if (!isObject(type)) return 'Anonymous';
    const shown: unknown = Reflect.get(type, 'displayName');
    if (typeof shown === 'string' && shown) return shown;
    if (typeof type === 'function') return type.name || 'Anonymous';
    // memo() and forwardRef() wrap the component in `type` or `render`.
    const inner: unknown = Reflect.get(type, 'render') ?? Reflect.get(type, 'type');
    return depth < 3 ? nameOf(inner, depth + 1) : 'Anonymous';
  };

  // React DevTools' walk: a fiber without an alternate mounted; a subtree whose child is still its alternate's
  // child was bailed out of and did not render.
  const onCommit = (root: unknown) => {
    if (commits.length >= MAX_COMMITS) {
      droppedCommits++;
      return;
    }
    const counts = new Map<string, [string, number, number]>();
    const current = fiberAt(root, 'current');
    const stack: [Fiber, boolean][] = current ? [[current, fiberAt(current, 'alternate') === null]] : [];
    for (let top = stack.pop(); top; top = stack.pop()) {
      const [fiber, mount] = top;
      if (COMPONENT_TAGS.has(fiber.tag) && (mount || ((fiber.flags ?? 0) & PERFORMED_WORK) !== 0)) {
        const name = nameOf(fiber.type, 0);
        const count = counts.get(name) ?? [name, 0, 0];
        count[1]++;
        if (mount) count[2]++;
        counts.set(name, count);
      }
      const alternate = fiberAt(fiber, 'alternate');
      if (!mount && alternate && Reflect.get(fiber, 'child') === Reflect.get(alternate, 'child')) continue;
      for (let child = fiberAt(fiber, 'child'); child; child = fiberAt(child, 'sibling'))
        stack.push([child, mount || fiberAt(child, 'alternate') === null]);
    }
    commits.push([Date.now(), [...counts.values()]]);
  };

  // A dev build's DevTools hook, or a minimal one React attaches to when it starts after this.
  const existing: unknown = Reflect.get(g, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
  const attached = new Map<number, unknown>();
  const devtools: object = isObject(existing)
    ? existing
    : {
        supportsFiber: true,
        renderers: attached,
        inject: (renderer: unknown) => {
          attached.set(attached.size + 1, renderer);
          return attached.size;
        },
        onCommitFiberRoot: () => undefined,
        onCommitFiberUnmount: () => undefined,
        onPostCommitFiberRoot: () => undefined,
        onScheduleFiberRoot: () => undefined,
        checkDCE: () => undefined,
      };
  if (devtools !== existing) Reflect.set(g, '__REACT_DEVTOOLS_GLOBAL_HOOK__', devtools);
  const previous: unknown = Reflect.get(devtools, 'onCommitFiberRoot');
  Reflect.set(devtools, 'onCommitFiberRoot', function (this: unknown, ...args: unknown[]) {
    if (on)
      try {
        onCommit(args[1]);
      } catch {
        // A React version whose fibers look different: the commit is still kept, its renders may read short.
        commits.push([Date.now(), []]);
      }
    return typeof previous === 'function' ? Reflect.apply(previous, this, args) : undefined;
  });
  const renderers = () => {
    const map: unknown = Reflect.get(devtools, 'renderers');
    return map instanceof Map ? map.size : 0;
  };

  const xhr: unknown = Reflect.get(g, 'XMLHttpRequest');
  const proto: unknown = typeof xhr === 'function' ? Reflect.get(xhr, 'prototype') : undefined;
  const open: unknown = isObject(proto) ? Reflect.get(proto, 'open') : undefined;
  const send: unknown = isObject(proto) ? Reflect.get(proto, 'send') : undefined;
  const network = isObject(proto) && typeof open === 'function' && typeof send === 'function';
  if (isObject(proto) && typeof open === 'function' && typeof send === 'function') {
    Reflect.set(proto, 'open', function (this: object, ...args: unknown[]) {
      Reflect.set(this, '__doubletake_open', [String(args[0]).toUpperCase(), String(args[1])]);
      return Reflect.apply(open, this, args);
    });
    Reflect.set(proto, 'send', function (this: object, ...args: unknown[]) {
      if (on && requests.length >= MAX_REQUESTS) dropped++;
      else if (on) {
        const opened: unknown = Reflect.get(this, '__doubletake_open');
        const [method = 'GET', url = ''] = Array.isArray(opened) ? opened.map(String) : [];
        const cut = url.search(/[?#]/);
        const entry: Entry = {
          method,
          url: cut < 0 ? url : url.slice(0, cut),
          query: cut < 0 ? '' : hashText(url.slice(cut)),
          body: bodyOf(args[0]),
          status: 0,
          bytes: 0,
          start: Date.now(),
        };
        requests.push(entry);
        const listen: unknown = Reflect.get(this, 'addEventListener');
        const at = (name: string) => Number(Reflect.get(this, name));
        if (typeof listen === 'function') {
          Reflect.apply(listen, this, [
            'readystatechange',
            () => {
              if (entry.headers === undefined && at('readyState') >= 2) entry.headers = Date.now();
            },
          ]);
          Reflect.apply(listen, this, [
            'loadend',
            () => {
              entry.end = Date.now();
              entry.status = at('status') || 0;
              const getHeader: unknown = Reflect.get(this, 'getResponseHeader');
              const length = Number(
                typeof getHeader === 'function' ? Reflect.apply(getHeader, this, ['content-length']) : null,
              );
              const response: unknown = Reflect.get(this, 'response');
              const size =
                typeof response === 'string'
                  ? utf8(response)
                  : isObject(response)
                    ? Number(Reflect.get(response, 'byteLength') ?? Reflect.get(response, 'size') ?? 0)
                    : 0;
              entry.bytes = length > 0 ? length : size || 0;
            },
          ]);
        }
      }
      return Reflect.apply(send, this, args);
    });
  }

  const probe: Probe = {
    begin() {
      begun = Date.now();
      dropped = 0;
      droppedCommits = 0;
      commits = [];
      requests = [];
      on = true;
    },
    read(from, to) {
      const lo = typeof from === 'number' && Number.isFinite(from) ? from : begun;
      const hi = typeof to === 'number' && Number.isFinite(to) ? to : Date.now();
      on = false;
      const counts = new Map<string, [string, number, number]>();
      let n = 0;
      for (const [t, rendered] of commits) {
        if (t < lo || t > hi) continue;
        n++;
        for (const [name, r, m] of rendered) {
          const c = counts.get(name) ?? [name, 0, 0];
          c[1] += r;
          c[2] += m;
          counts.set(name, c);
        }
      }
      let renders = 0;
      let mounts = 0;
      const components = [...counts.values()];
      for (const [, r, m] of components) {
        renders += r;
        mounts += m;
      }
      components.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      // A request still in flight at the window's end is listed without its status and size.
      const done = (r: Entry) => r.end !== undefined && r.end <= hi;
      return {
        schema: 'doubletake.probe.v1',
        from: lo,
        to: hi,
        ms: hi - lo,
        begun,
        renderers: renderers(),
        commits: n,
        renders,
        mounts,
        components: components.slice(0, MAX_COMPONENTS),
        requests: requests
          .filter((r) => r.start >= lo && r.start <= hi)
          .map((r) => ({
            method: r.method,
            url: r.url,
            query: r.query,
            body: r.body,
            status: done(r) ? r.status : 0,
            bytes: done(r) ? r.bytes : 0,
            start: r.start - lo,
            headers: r.headers !== undefined && r.headers <= hi ? r.headers - lo : undefined,
            end: done(r) && r.end !== undefined ? r.end - lo : undefined,
          })),
        network,
        dropped,
        droppedCommits,
      };
    },
  };
  Reflect.set(g, KEY, probe);
  return probe;
}
