// What a screen does inside the app, per window: React commits and the components each one rendered (through
// React's DevTools hook), and every XMLHttpRequest (so fetch) with its timing and size. The host opens a window
// with begin() and closes it with read(), over CDP on a dev client (it injects this same function) or through a
// bridge the app exposes. Nothing is counted outside a window.
//
// installProbe is injected as source text: everything it uses lives inside it, and only what Hermes runs.

/** One request: method and URL without its query; query and body as short hashes. Times are ms into the window. */
export type ProbeRequest = {
  method: string;
  url: string;
  query: string;
  body: string;
  status: number;
  bytes: number;
  start: number;
  /** Headers received. */
  headers?: number;
  /** Finished (loaded, failed or aborted); absent while in flight. */
  end?: number;
};

export type ProbeRead = {
  schema: 'doubletake.probe.v1';
  ms: number;
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
  /** Requests past the cap, not listed. */
  dropped: number;
};

export type Probe = { begin(): void; read(): ProbeRead };

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
        read: () => Reflect.apply(read, present, []),
      };
  }
  type Fiber = { tag: number; flags?: number; type?: unknown };
  const MAX_REQUESTS = 2000;
  const MAX_COMPONENTS = 60;
  // Function, class, forwardRef, memo and simple memo components; PerformedWork marks the ones that rendered.
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  const PERFORMED_WORK = 1;

  let on = false;
  let t0 = Date.now();
  let commits = 0;
  let dropped = 0;
  let counts = new Map<string, [number, number]>();
  let requests: ProbeRequest[] = [];

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- injected as source: it all stays inside
  const isObject = (v: unknown): v is object => (typeof v === 'object' && v !== null) || typeof v === 'function';
  const isFiber = (v: unknown): v is Fiber => isObject(v) && typeof Reflect.get(v, 'tag') === 'number';
  const fiberAt = (v: unknown, key: string): Fiber | null => {
    const next: unknown = isObject(v) ? Reflect.get(v, key) : null;
    return isFiber(next) ? next : null;
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- injected as source: it all stays inside
  const hash = (text: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(36);
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
    commits++;
    const current = fiberAt(root, 'current');
    const stack: [Fiber, boolean][] = current ? [[current, fiberAt(current, 'alternate') === null]] : [];
    for (let top = stack.pop(); top; top = stack.pop()) {
      const [fiber, mount] = top;
      if (COMPONENT_TAGS.has(fiber.tag) && (mount || ((fiber.flags ?? 0) & PERFORMED_WORK) !== 0)) {
        const name = nameOf(fiber.type, 0);
        const count = counts.get(name) ?? [0, 0];
        count[0]++;
        if (mount) count[1]++;
        counts.set(name, count);
      }
      const alternate = fiberAt(fiber, 'alternate');
      if (!mount && alternate && Reflect.get(fiber, 'child') === Reflect.get(alternate, 'child')) continue;
      for (let child = fiberAt(fiber, 'child'); child; child = fiberAt(child, 'sibling'))
        stack.push([child, mount || fiberAt(child, 'alternate') === null]);
    }
  };

  let hook: unknown = Reflect.get(g, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
  if (!isObject(hook)) {
    const renderers = new Map<number, unknown>();
    hook = {
      supportsFiber: true,
      renderers,
      inject: (renderer: unknown) => {
        renderers.set(renderers.size + 1, renderer);
        return renderers.size;
      },
      onCommitFiberRoot: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      onScheduleFiberRoot: () => undefined,
      checkDCE: () => undefined,
    };
    Reflect.set(g, '__REACT_DEVTOOLS_GLOBAL_HOOK__', hook);
  }
  const devtools = hook;
  const previous: unknown = Reflect.get(devtools, 'onCommitFiberRoot');
  Reflect.set(devtools, 'onCommitFiberRoot', function (this: unknown, ...args: unknown[]) {
    if (on)
      try {
        onCommit(args[1]);
      } catch {
        // A React version whose fibers look different: commits still count, renders may read short.
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
        const [method, url] = Array.isArray(opened) ? opened.map(String) : ['GET', ''];
        const cut = (url ?? '').search(/[?#]/);
        const body = args[0];
        const entry: ProbeRequest = {
          method: method ?? 'GET',
          url: cut < 0 ? (url ?? '') : (url ?? '').slice(0, cut),
          query: cut < 0 ? '' : hash((url ?? '').slice(cut)),
          body: typeof body === 'string' ? hash(body) : body === undefined || body === null ? '' : 'binary',
          status: 0,
          bytes: 0,
          start: Date.now() - t0,
        };
        requests.push(entry);
        const listen: unknown = Reflect.get(this, 'addEventListener');
        const at = (name: string) => Number(Reflect.get(this, name));
        if (typeof listen === 'function') {
          Reflect.apply(listen, this, [
            'readystatechange',
            () => {
              if (entry.headers === undefined && at('readyState') >= 2) entry.headers = Date.now() - t0;
            },
          ]);
          Reflect.apply(listen, this, [
            'loadend',
            () => {
              entry.end = Date.now() - t0;
              entry.status = at('status') || 0;
              const getHeader: unknown = Reflect.get(this, 'getResponseHeader');
              const length = Number(
                typeof getHeader === 'function' ? Reflect.apply(getHeader, this, ['content-length']) : null,
              );
              const response: unknown = Reflect.get(this, 'response');
              const size =
                typeof response === 'string'
                  ? response.length
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
      t0 = Date.now();
      commits = 0;
      dropped = 0;
      counts = new Map();
      requests = [];
      on = true;
    },
    read() {
      on = false;
      let renders = 0;
      let mounts = 0;
      const components: [string, number, number][] = [];
      for (const [name, [r, m]] of counts) {
        renders += r;
        mounts += m;
        components.push([name, r, m]);
      }
      components.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      return {
        schema: 'doubletake.probe.v1',
        ms: Date.now() - t0,
        renderers: renderers(),
        commits,
        renders,
        mounts,
        components: components.slice(0, MAX_COMPONENTS),
        // A copy: requests in flight still finish into the window's own entries.
        requests: JSON.parse(JSON.stringify(requests)),
        network,
        dropped,
      };
    },
  };
  Reflect.set(g, KEY, probe);
  return probe;
}
