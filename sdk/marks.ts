// The marks protocol, for apps that use nothing else from doubletake: `mark(name)` once per name keeps
// `{ name, epochMs }` in `globalThis.__PERF_MARKS__` and logs `[perf-mark] <name> <epochMs>`. Writing that
// line yourself works the same; this file only saves the copy.

type PerfMark = { name: string; epochMs: number };

/** Marks a moment of the app's start, such as `mark('home_interactive')`; later calls with the name do nothing. */
export function mark(name: string): void {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`perf-mark: a mark name is letters, digits, _ . and - (${name})`);
  const known: unknown = Reflect.get(globalThis, '__PERF_MARKS__');
  const marks: PerfMark[] = Array.isArray(known) ? known : [];
  if (marks !== known) Reflect.set(globalThis, '__PERF_MARKS__', marks);
  if (marks.some((m) => m.name === name)) return;
  const epochMs = Date.now();
  marks.push({ name, epochMs });
  // oxlint-disable-next-line no-console -- the protocol is a console line: release builds keep it in the log
  console.log(`[perf-mark] ${name} ${epochMs}`);
}
