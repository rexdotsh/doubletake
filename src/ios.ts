import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { type Action, type Device, type Recording, logTap } from './device.ts';
import { run, stop, stream, which } from './sh.ts';
import { dig, isRecord } from './util.ts';

type SimDevice = { udid: string; name: string; state: string; runtime: string };

async function simctl(...args: string[]) {
  return (await run('xcrun', ['simctl', ...args])).stdout;
}

function runtimeName(id: string): string {
  return id
    .replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '')
    .replace(/-/g, ' ')
    .replace(/ (\d+) (\d+)$/, ' $1.$2');
}

export async function listSimulators(): Promise<SimDevice[]> {
  const parsed: unknown = JSON.parse(await simctl('list', 'devices', '-j'));
  const devices = dig(parsed, 'devices');
  if (!isRecord(devices)) throw new Error('simctl list devices -j: no devices');
  return Object.entries(devices).flatMap(([runtime, list]) =>
    (Array.isArray(list) ? list : []).flatMap((d: unknown): SimDevice[] => {
      const [udid, name, state] = [dig(d, 'udid'), dig(d, 'name'), dig(d, 'state')];
      if (
        typeof udid !== 'string' ||
        typeof name !== 'string' ||
        typeof state !== 'string' ||
        dig(d, 'isAvailable') === false
      )
        return [];
      return [{ udid, name, state, runtime: runtimeName(runtime) }];
    }),
  );
}

async function plist(app: string, key: string): Promise<string> {
  return (await run('plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Info.plist')])).stdout.trim();
}

/** "1:02.34" or "1:02:03.45" (ps time) to ms. */
export function psTime(text: string): number {
  const parts = text.trim().split(':').map(Number);
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0) * 1000);
}

// A simulator app is a host process, so its exec time is in the host's process table, to the microsecond.
// simctl launch itself takes 0.2 to 0.6 s, too noisy to time from. Node cannot call proc_pidinfo; python3 ships with Xcode.
const PROC_START = `
import ctypes, struct, sys
buf = ctypes.create_string_buffer(136)
if ctypes.CDLL('/usr/lib/libproc.dylib').proc_pidinfo(int(sys.argv[1]), 3, ctypes.c_uint64(0), buf, 136) != 136: sys.exit(1)
sec, usec = struct.unpack_from('<QQ', buf, 120)
print(sec * 1000 + usec / 1000)
`;

async function processStart(pid: number): Promise<number> {
  return Number((await run('/usr/bin/python3', ['-c', PROC_START, String(pid)])).stdout.trim());
}

/** Picks the simulator: by udid or name, else the only booted one. Boots it when asked by name or udid. */
export async function iosDevice(want?: string): Promise<Device> {
  const all = await listSimulators();
  const booted = all.filter((d) => d.state === 'Booted');
  const sim = want ? all.find((d) => d.udid === want || d.name === want) : booted.length === 1 ? booted[0] : undefined;
  if (!sim) {
    const why = want ? `no simulator named or with udid ${want}` : `${booted.length} simulators are booted`;
    throw new Error(`${why}: pass --device <udid|name> (\`xcrun simctl list devices\`)`);
  }
  if (sim.state !== 'Booted') await simctl('boot', sim.udid);
  await simctl('bootstatus', sim.udid, '-b');
  return simulator(sim.udid, sim.name, sim.runtime, (await which('axe')) ?? undefined);
}

/** The simulator's screen in points, from AXe's accessibility tree (its first element's frame). */
async function screenPoints(axe: string, udid: string): Promise<{ w: number; h: number }> {
  const tree: unknown = JSON.parse((await run(axe, ['describe-ui', '--udid', udid])).stdout);
  const [w, h] = [dig(tree, 0, 'frame', 'width'), dig(tree, 0, 'frame', 'height')];
  if (typeof w !== 'number' || typeof h !== 'number') throw new Error('axe describe-ui gave no screen frame');
  return { w, h };
}

/** A coordinate in points: a fraction of the screen, or points already. */
const axis = (v: number, size: number) => String(Math.round(v <= 1 ? v * size : v));

/**
 * Taps and swipes through AXe. A text tap waits up to 10 s for an element with that accessibility label (an
 * exact match). AXe returns when the gesture ends, not when the screen settles: follow it with a `wait` or
 * `sleep` where the run must include what it starts.
 */
async function axeInput(
  axe: string,
  udid: string,
  screen: { w: number; h: number },
  actions: readonly Action[],
): Promise<void> {
  for (const a of actions) {
    if ('tap' in a) {
      const at = a.tap;
      if (typeof at === 'string') await run(axe, ['tap', '--label', at, '--wait-timeout', '10', '--udid', udid]);
      else await run(axe, ['tap', '-x', axis(at[0], screen.w), '-y', axis(at[1], screen.h), '--udid', udid]);
    } else {
      const { from, to, duration } = a.swipe;
      await run(axe, [
        'swipe',
        '--start-x',
        axis(from[0], screen.w),
        '--start-y',
        axis(from[1], screen.h),
        '--end-x',
        axis(to[0], screen.w),
        '--end-y',
        axis(to[1], screen.h),
        '--duration',
        String(duration / 1000),
        '--udid',
        udid,
      ]);
    }
  }
}

function simulator(udid: string, name: string, os: string, axe: string | undefined): Device {
  let screen: { w: number; h: number } | undefined;
  const executables = new Map<string, string>();
  return {
    platform: 'ios',
    id: udid,
    name,
    os,
    async prepare() {
      await simctl(
        'status_bar',
        udid,
        'override',
        '--time',
        '9:41',
        '--dataNetwork',
        'wifi',
        '--wifiBars',
        '3',
        '--batteryState',
        'charged',
        '--batteryLevel',
        '100',
      );
    },
    appId: (app) => plist(app, 'CFBundleIdentifier'),
    async clone(app, appId, dir) {
      const extensions = await Promise.all(
        ['PlugIns', 'Extensions'].map((d) => readdir(join(app, d)).catch((): string[] => [])),
      );
      if (extensions.flat().length)
        throw new Error(
          `${basename(app)} embeds app extensions, whose ids must share the app's prefix: --side-by-side cannot clone it`,
        );
      const copy = join(dir, basename(app));
      await rm(copy, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await run('ditto', [app, copy]);
      await run('plutil', ['-replace', 'CFBundleIdentifier', '-string', appId, join(copy, 'Info.plist')]);
      // Ad-hoc and without entitlements: the simulator refuses an ad-hoc app that claims store entitlements.
      await run('codesign', ['--force', '--sign', '-', '--timestamp=none', copy]);
      return copy;
    },
    async install(app) {
      await simctl('install', udid, app);
      executables.set(await plist(app, 'CFBundleIdentifier'), await plist(app, 'CFBundleExecutable'));
    },
    async uninstall(appId) {
      await run('xcrun', ['simctl', 'uninstall', udid, appId], { check: false });
    },
    async isInstalled(appId) {
      return (await run('xcrun', ['simctl', 'get_app_container', udid, appId], { check: false })).code === 0;
    },
    async terminate(appId) {
      await run('xcrun', ['simctl', 'terminate', udid, appId], { check: false });
    },
    async launch(appId) {
      const out = await simctl('launch', udid, appId);
      const pid = Number(/:\s*(\d+)/.exec(out)?.[1]);
      if (!pid) throw new Error(`simctl launch printed no pid: ${out}`);
      return { t0: await processStart(pid), pid };
    },
    cpuMs: async (pid) => psTime((await run('ps', ['-o', 'time=', '-p', String(pid)])).stdout),
    async memory(pid) {
      const dir = await mkdtemp(join(tmpdir(), 'doubletake-'));
      try {
        const file = join(dir, 'footprint.json');
        await run('footprint', ['-p', String(pid), '--noCategories', '-f', 'bytes', '-j', file]);
        const json: unknown = JSON.parse(await readFile(file, 'utf8'));
        const mib = (key: string) => {
          const bytes = dig(json, 'processes', 0, 'auxiliary', key);
          return typeof bytes === 'number' ? bytes / 2 ** 20 : undefined;
        };
        return { endMiB: mib('phys_footprint'), peakMiB: mib('phys_footprint_peak') };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async logs(appId) {
      const executable = executables.get(appId);
      const predicate = executable
        ? `process == "${executable}" AND eventMessage CONTAINS "[doubletake]"`
        : 'eventMessage CONTAINS "[doubletake]"';
      return logTap(
        'xcrun',
        ['simctl', 'spawn', udid, 'log', 'stream', '--style', 'ndjson', '--level', 'debug', '--predicate', predicate],
        (line) => {
          if (!line.startsWith('{')) return null;
          const json: unknown = JSON.parse(line);
          const message = dig(json, 'eventMessage');
          const pid = dig(json, 'processID');
          return typeof message === 'string' ? { message, pid: typeof pid === 'number' ? pid : undefined } : null;
        },
      );
    },
    clockOffset: () => Promise.resolve(0),
    async record(path): Promise<Recording> {
      const child = stream('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', path], () => {});
      const startedAt = await new Promise<number | undefined>((resolve) => {
        child.stderr?.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('Recording started')) resolve(Date.now());
        });
        setTimeout(() => resolve(undefined), 5000);
      });
      if (startedAt === undefined) throw new Error('simctl recordVideo did not start within 5 s');
      return {
        startedAt,
        async stop() {
          await stop(child);
          return path;
        },
      };
    },
    openUrl: async (url) => void (await simctl('openurl', udid, url)),
    async prepareInput() {
      // After setup and before the window: the app on screen sets the orientation AXe's points follow.
      if (axe) screen = await screenPoints(axe, udid);
    },
    async input(_appId, actions) {
      if (!axe) throw new Error('taps and swipes on the iOS Simulator need AXe: brew install cameroncooke/axe/axe');
      screen ??= await screenPoints(axe, udid);
      await axeInput(axe, udid, screen, actions);
    },
  };
}
