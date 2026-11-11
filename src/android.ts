import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Device, type Recording, logTap } from './device.ts';
import { maestroInline } from './maestro.ts';
import { run, sleep, stop, stream } from './sh.ts';

type Adb = (...args: string[]) => Promise<string>;

async function serials(): Promise<string[]> {
  const out = (await run('adb', ['devices'])).stdout;
  return out
    .split('\n')
    .slice(1)
    .filter((l) => l.endsWith('\tdevice'))
    .map((l) => l.split('\t')[0] ?? '');
}

async function aapt2(): Promise<string | undefined> {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) return undefined;
  const versions = (await readdir(join(sdk, 'build-tools')).catch((): string[] => [])).toSorted();
  const latest = versions.at(-1);
  return latest ? join(sdk, 'build-tools', latest, 'aapt2') : undefined;
}

/** Parses `am start -W` output: TotalTime is the launch to the first frame. */
export function parseAmStart(out: string): { totalTime?: number; launchState?: string } {
  const total = /TotalTime:\s*(\d+)/.exec(out)?.[1];
  return { totalTime: total ? Number(total) : undefined, launchState: /LaunchState:\s*(\w+)/.exec(out)?.[1] };
}

/** Parses `dumpsys gfxinfo <package>`. */
export function parseGfxinfo(out: string): { total: number; janky: number; p90: number } {
  const num = (re: RegExp) => Number(re.exec(out)?.[1] ?? Number.NaN);
  return {
    total: num(/Total frames rendered:\s*(\d+)/),
    janky: num(/Janky frames:\s*(\d+)/),
    p90: num(/90th percentile:\s*(\d+)ms/),
  };
}

/** Parses `dumpsys meminfo <pid>`: TOTAL PSS and TOTAL RSS in KB, as MiB. */
export function parseMeminfo(out: string): { pss?: number; rss?: number } {
  const kb = (re: RegExp) => {
    const v = re.exec(out)?.[1];
    return v ? Number(v) / 1024 : undefined;
  };
  return { pss: kb(/TOTAL PSS:\s*(\d+)/), rss: kb(/TOTAL RSS:\s*(\d+)/) };
}

/** A coordinate: a fraction of the screen, or pixels. */
const px = (v: number, size: number) => String(Math.round(v <= 1 ? v * size : v));

/** "0:01.23" (toybox ps TIME+) to ms. */
function timePlus(text: string): number {
  const parts = text.trim().split(':').map(Number);
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0) * 1000);
}

/** Picks the device: by serial, else the only one attached. */
export async function androidDevice(want?: string): Promise<Device> {
  const all = await serials();
  const serial = want ?? (all.length === 1 ? all[0] : undefined);
  if (!serial || !all.includes(serial))
    throw new Error(
      `${want ? `no device ${want}` : `${all.length} devices attached`}: pass --device <serial> (\`adb devices\`)`,
    );
  const adb: Adb = async (...args) => (await run('adb', ['-s', serial, ...args])).stdout;
  const shell = (cmd: string) => adb('shell', cmd);
  const [model, release, sdk, qemu] = (
    await shell(
      'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.kernel.qemu',
    )
  )
    .split('\n')
    .map((s) => s.trim());
  return device(
    serial,
    adb,
    shell,
    `${model ?? 'Android'}${qemu === '1' ? ' (emulator)' : ''}`,
    `${release ?? '?'} (API ${sdk ?? '?'})`,
  );
}

function device(serial: string, adb: Adb, shell: (cmd: string) => Promise<string>, name: string, os: string): Device {
  const components = new Map<string, string>();
  const component = async (pkg: string) => {
    const known = components.get(pkg);
    if (known) return known;
    const resolved =
      (await shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg}`))
        .trim()
        .split('\n')
        .at(-1) ?? '';
    if (!resolved.includes('/')) throw new Error(`${pkg} has no launcher activity on ${serial}`);
    components.set(pkg, resolved);
    return resolved;
  };
  const screen = async () => {
    const [w, h] = (/(\d+)x(\d+)/.exec(await shell('wm size'))?.slice(1) ?? ['1080', '2400']).map(Number);
    return { w: w ?? 1080, h: h ?? 2400 };
  };

  return {
    platform: 'android',
    id: serial,
    name,
    os,
    async prepare() {
      await shell(
        'settings put global sysui_demo_allowed 1; am broadcast -a com.android.systemui.demo -e command enter; am broadcast -a com.android.systemui.demo -e command clock -e hhmm 1200; am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false',
      );
    },
    async appId(apk) {
      const tool = await aapt2();
      if (!tool) throw new Error('set ANDROID_HOME so doubletake can read the package name with aapt2');
      const out = (await run(tool, ['dump', 'badging', apk])).stdout;
      const pkg = /package: name='([^']+)'/.exec(out)?.[1];
      if (!pkg) throw new Error(`aapt2 found no package name in ${apk}`);
      return pkg;
    },
    async install(apk) {
      await adb('install', '-r', '-d', apk);
    },
    async isInstalled(pkg) {
      return (await shell(`pm path ${pkg} || true`)).includes('package:');
    },
    async terminate(pkg) {
      await shell(`am force-stop ${pkg}`);
    },
    async launch(pkg) {
      const before = Date.now();
      const out = await shell(`am start -W -n ${await component(pkg)}`);
      const { totalTime } = parseAmStart(out);
      const pid = Number((await shell(`pidof ${pkg} || true`)).trim().split(/\s+/)[0]);
      if (!pid) throw new Error(`${pkg} is not running after am start: ${out.trim()}`);
      // TotalTime counts from the intent; the process starts a few ms later. Marks are timed from the intent
      // (ActivityTaskManager's START line), as Android's own TTID is.
      const startLine = (
        await shell(`logcat -d -v epoch -s ActivityTaskManager:I | grep 'START u0' | grep '${pkg}' | tail -1`)
      ).trim();
      const t = Number(/^\s*(\d+\.\d+)/.exec(startLine)?.[1]);
      const offset = await clockOffset(shell);
      return {
        t0: Number.isFinite(t) && t * 1000 >= before + offset - 5000 ? t * 1000 - offset : before,
        pid,
        ttid: totalTime,
      };
    },
    cpuMs: async (pid) => timePlus((await shell(`ps -o TIME+= -p ${pid}`)).trim().split('\n').at(-1) ?? '0'),
    async memory(pid) {
      const meminfo = parseMeminfo(await shell(`dumpsys meminfo ${pid}`));
      const hwm = /VmHWM:\s*(\d+)/.exec(await shell(`cat /proc/${pid}/status 2>/dev/null || true`))?.[1];
      return { endMiB: meminfo.pss, peakMiB: hwm ? Number(hwm) / 1024 : undefined };
    },
    logs: () =>
      logTap('adb', ['-s', serial, 'logcat', '-v', 'epoch', '-T', '1'], (line) => {
        const at = line.indexOf('[doubletake] ');
        return at < 0 ? null : line.slice(at);
      }),
    clockOffset: () => clockOffset(shell),
    async record(path): Promise<Recording> {
      const remote = `/data/local/tmp/doubletake-${Date.now()}.mp4`;
      const child = stream('adb', ['-s', serial, 'shell', 'screenrecord', '--bit-rate', '8000000', remote], () => {});
      // screenrecord prints nothing when it starts; it is capturing well within half a second.
      await sleep(500);
      return {
        startedAt: Date.now() - 250,
        async stop() {
          await shell('pkill -INT screenrecord || true');
          await stop(child, 'SIGTERM');
          await sleep(500);
          await adb('pull', remote, path);
          await shell(`rm -f ${remote}`);
          return path;
        },
      };
    },
    async openUrl(url) {
      await shell(`am start -W -a android.intent.action.VIEW -d '${url.replaceAll("'", '')}'`);
    },
    frames: {
      reset: async (pkg) => void (await shell(`dumpsys gfxinfo ${pkg} reset`)),
      read: async (pkg) => parseGfxinfo(await shell(`dumpsys gfxinfo ${pkg}`)),
    },
    async input(pkg, actions) {
      if (actions.some((a) => 'tap' in a && typeof a.tap === 'string'))
        return maestroInline(
          serial,
          pkg,
          actions.map((a) =>
            'tap' in a
              ? `tapOn: ${JSON.stringify(a.tap)}`
              : `swipe:\n    start: "${a.swipe.from.join(',')}"\n    end: "${a.swipe.to.join(',')}"`,
          ),
        );
      const { w, h } = await screen();
      for (const a of actions) {
        if ('tap' in a && typeof a.tap !== 'string') await shell(`input tap ${px(a.tap[0], w)} ${px(a.tap[1], h)}`);
        else if ('swipe' in a)
          await shell(
            `input swipe ${px(a.swipe.from[0], w)} ${px(a.swipe.from[1], h)} ${px(a.swipe.to[0], w)} ${px(a.swipe.to[1], h)} ${a.swipe.duration}`,
          );
      }
      return undefined;
    },
  };
}

/** Device clock minus host clock, from the midpoint of one `date` round trip (a few ms on a local emulator). */
async function clockOffset(shell: (cmd: string) => Promise<string>): Promise<number> {
  const before = Date.now();
  const now = Number((await shell('date +%s%3N')).trim());
  const after = Date.now();
  return Number.isFinite(now) ? now - (before + after) / 2 : 0;
}
