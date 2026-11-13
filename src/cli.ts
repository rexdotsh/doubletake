import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { type Bench, allSteps, loadBench, ms } from './bench.ts';
import type { Device } from './device.ts';
import { Refusal } from './device.ts';
import { androidDevice } from './android.ts';
import { appRoot, bundleReport, groupAppCode, readBundle } from './bundle.ts';
import { runBench, runCheck } from './experiment.ts';
import { serve } from './mcp.ts';
import { iosDevice, listSimulators } from './ios.ts';
import type { Platform } from './metrics.ts';
import { type Host, runRemote, sendArtifact } from './remote.ts';
import { card, summary } from './report.ts';
import { run, which } from './sh.ts';
import { type Experiment, type Variant, experimentDir, loadExperiment, newId } from './store.ts';
import { ffmpegPath } from './visual.ts';
import { readLaunches, timelineSvg, timelineText, timelines } from './waterfall.ts';

const USAGE = `doubletake ${pkg.version}: A/B performance for React Native apps on simulators and emulators

  doubletake bench <file> --base <app> --head <app>   paired runs of two builds, a verdict per case
  doubletake check <file> --head <app>                each case once: does it work, what does it read?
  doubletake report [exp|latest] [--format text|md|json] [--comment <pr> [--repo owner/name]]
  doubletake timeline [exp|latest] [--case name] [--format text|json] [--out dir]
                                                      launch timelines: marks per launch, median waterfalls, SVGs
  doubletake bundle <js> <map> [<base js> <base map>] what a Metro bundle ships, by package; with a base, the change
  doubletake status                                   what this machine can measure
  doubletake mcp                                      an MCP server (stdio) with the same commands as tools

  <app>     a .app (iOS Simulator) or .apk (Android) build, installed:<bundle id>, or with --host,
            host:<path> for a build already on that machine
  --case <name>           only this case (repeatable)
  --pairs auto|<n>        auto: planned looks at 8, 12, 18, 26, 40 pairs (default); n: one look at n
  --runs <n>              measured runs per block (default: the bench file's, else 3)
  --warmup <n>            discarded runs at the start of each block (default 1)
  --labels <base>,<head>  what reports call the sides (default: the build file names)
  --platform ios|android  when the builds do not say
  --device <id|name>      simulator udid or name, or adb serial
  --host "<ssh command>"  run on that machine (e.g. "ssh mac"): builds and bench file go over, results come back
  --host-init "<shell>"   run first on the host (e.g. ". ~/env.sh")
  --video [case]          after the pairs, film one more run per side and put them side by side
  --side-by-side          iOS: install both builds as copies under <bundle id>.doubletake{base,head}, so both stay
                          installed (no reinstall per block); copies have no entitlements and fresh containers
  --queue <duration>      how long the whole bench may wait for a quiet host (default 30m), then exit 4
  --fail-on-regression    exit 6 when a primary is worse (CI)
  --json                  print the experiment record

  exit codes: 0 done · 1 error · 4 a primary or a case was refused · 5 not every primary decided · 6 regression
`;

type Flags = {
  base?: string;
  head?: string;
  case?: string[];
  pairs?: string;
  runs?: string;
  warmup?: string;
  labels?: string;
  platform?: string;
  device?: string;
  host?: string;
  'host-init'?: string;
  id?: string;
  video?: string;
  queue?: string;
  'side-by-side'?: boolean;
  'fail-on-regression'?: boolean;
  json?: boolean;
  format?: string;
  comment?: string;
  repo?: string;
  out?: string;
  help?: boolean;
  version?: boolean;
};

const OPTIONS = {
  base: { type: 'string' },
  head: { type: 'string' },
  case: { type: 'string', multiple: true },
  pairs: { type: 'string' },
  runs: { type: 'string' },
  warmup: { type: 'string' },
  labels: { type: 'string' },
  platform: { type: 'string' },
  device: { type: 'string' },
  host: { type: 'string' },
  'host-init': { type: 'string' },
  id: { type: 'string' },
  video: { type: 'string' },
  queue: { type: 'string' },
  'side-by-side': { type: 'boolean' },
  'fail-on-regression': { type: 'boolean' },
  json: { type: 'boolean' },
  format: { type: 'string' },
  comment: { type: 'string' },
  repo: { type: 'string' },
  out: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

const out = (s: string): void => void process.stdout.write(`${s}\n`);
const log = (s: string): void => void process.stderr.write(`${s}\n`);

function platformOf(flags: Flags, specs: (string | undefined)[]): Platform {
  if (flags.platform === 'ios' || flags.platform === 'android') return flags.platform;
  if (flags.platform) throw new Error(`--platform is ios or android, not ${flags.platform}`);
  const kinds = new Set<Platform>();
  for (const spec of specs) {
    if (spec?.replace(/\/$/, '').endsWith('.app')) kinds.add('ios');
    if (spec?.endsWith('.apk')) kinds.add('android');
  }
  const [only] = kinds;
  if (only && kinds.size === 1) return only;
  throw new Error('say which platform: --platform ios|android');
}

async function openDevice(platform: Platform, want?: string): Promise<Device> {
  return platform === 'ios' ? iosDevice(want) : androidDevice(want);
}

async function hostLine(): Promise<string> {
  const cpu = cpus()[0]?.model.trim() ?? 'unknown CPU';
  const gb = Math.round(totalmem() / 2 ** 30);
  const os =
    process.platform === 'darwin'
      ? `macOS ${(await run('sw_vers', ['-productVersion'], { check: false })).stdout.trim()}`
      : process.platform;
  return `${cpu}, ${gb} GB, ${os}`;
}

async function variant(
  device: Device,
  role: 'base' | 'head',
  spec: string,
  label: string | undefined,
): Promise<Variant> {
  if (spec.startsWith('installed:'))
    return { role, spec, appId: spec.slice('installed:'.length), label: label ?? spec.slice('installed:'.length) };
  const artifact = resolve(spec);
  return {
    role,
    spec,
    artifact,
    appId: await device.appId(artifact),
    label: label ?? basename(artifact).replace(/\.(app|apk)\/?$/, ''),
  };
}

function selectCases(bench: Bench, wanted: string[] | undefined): string[] {
  const all = Object.keys(bench.cases);
  for (const name of wanted ?? [])
    if (!all.includes(name)) throw new Error(`no case ${name} (cases: ${all.join(', ')})`);
  return wanted?.length ? wanted : all;
}

function int(text: string | undefined, name: string): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} takes a whole number`);
  return n;
}

async function remote(command: 'bench' | 'check', file: string, ssh: string, flags: Flags): Promise<void> {
  const host: Host = { ssh, init: flags['host-init'] };
  const id = flags.id ?? newId('exp');
  const sides: [string, string | undefined][] = [
    ['--base', flags.base],
    ['--head', flags.head],
  ];
  const sent: string[] = [];
  for (const [flag, spec] of sides) {
    if (!spec) continue;
    if (spec.startsWith('installed:')) sent.push(flag, spec);
    else if (spec.startsWith('host:')) sent.push(flag, spec.slice('host:'.length));
    else sent.push(flag, await sendArtifact(host, resolve(spec)));
  }
  const labels =
    flags.labels ??
    [flags.base, flags.head]
      .filter(Boolean)
      .map((s) => basename((s ?? '').replace(/^host:/, '')).replace(/\.(app|apk)\/?$/, ''))
      .join(',');
  const passthrough = (['pairs', 'runs', 'warmup', 'device', 'video', 'queue'] as const).flatMap((k) => {
    const v = flags[k];
    return v ? [`--${k}`, v] : [];
  });
  const platform = platformOf(flags, [flags.base, flags.head]);
  const fetched = await runRemote(host, {
    id,
    bench: file,
    args: (benchPath) => [
      command,
      benchPath,
      ...sent,
      '--id',
      id,
      '--labels',
      labels,
      '--platform',
      platform,
      ...(flags.case ?? []).flatMap((c) => ['--case', c]),
      ...passthrough,
      ...(flags['fail-on-regression'] ? ['--fail-on-regression'] : []),
      ...(flags['side-by-side'] ? ['--side-by-side'] : []),
    ],
  });
  if (!fetched) return;
  const { experiment } = await loadExperiment(id);
  out(flags.json ? JSON.stringify(experiment, null, 2) : summary(experiment));
}

async function measure(command: 'bench' | 'check', file: string | undefined, flags: Flags): Promise<void> {
  if (!file)
    throw new Error(`usage: doubletake ${command} <file> ${command === 'bench' ? '--base <app> ' : ''}--head <app>`);
  if (!flags.head || (command === 'bench' && !flags.base))
    throw new Error(`${command} needs ${command === 'bench' ? '--base and ' : ''}--head`);
  if (flags.host) return remote(command, file, flags.host, flags);
  const loaded = await loadBench(file);
  const cases = selectCases(loaded, flags.case);
  const platform = platformOf(flags, [flags.base, flags.head]);
  const device = await openDevice(platform, flags.device);
  const [baseLabel, headLabel] = flags.labels?.split(',') ?? [];
  let head = await variant(device, 'head', flags.head, headLabel);
  let base = command === 'bench' && flags.base ? await variant(device, 'base', flags.base, baseLabel) : head;
  const id = flags.id ?? newId('exp');
  const dir = experimentDir(id);
  if (flags['side-by-side'] && command === 'bench' && base.appId === head.appId && base.artifact && head.artifact) {
    // Both sides get the same treatment: a copy under a new id, its own container, the same signing.
    if (!device.clone) throw new Error('--side-by-side needs a clone of the build under another id: iOS only');
    const opens = cases.filter((name) =>
      allSteps([...(loaded.cases[name]?.setup ?? []), ...(loaded.cases[name]?.run ?? [])]).some(
        (s) => typeof s === 'object' && 'open' in s,
      ),
    );
    if (opens.length)
      throw new Error(
        `--side-by-side: both copies claim the same URL schemes, so deep links (${opens.join(', ')}) could open either`,
      );
    const copy = async (v: Variant, suffix: string) => ({
      ...v,
      appId: `${v.appId}.doubletake${suffix}`,
      artifact: await device.clone?.(v.artifact ?? '', `${v.appId}.doubletake${suffix}`, join(dir, suffix)),
    });
    [base, head] = await Promise.all([copy(base, 'base'), copy(head, 'head')]);
    // Fresh containers: an earlier experiment's copies keep their data across installs.
    for (const v of [base, head]) {
      await device.uninstall(v.appId);
      if (await device.isInstalled(v.appId))
        throw new Error(`could not uninstall ${v.appId}: its old container would carry over`);
    }
  }
  const pairs = flags.pairs === undefined || flags.pairs === 'auto' ? 'auto' : (int(flags.pairs, 'pairs') ?? 0);
  const runs = int(flags.runs, 'runs');
  const warmup = int(flags.warmup, 'warmup') ?? 1;
  const experiment: Experiment = {
    schema: 'doubletake.experiment.v1',
    id,
    kind: command === 'bench' ? 'experiment' : 'check',
    created: new Date().toISOString(),
    file: basename(file),
    comparison: 'builds',
    device: { platform, name: device.name, os: device.os, id: device.id, host: await hostLine() },
    variants: command === 'bench' ? [base, head] : [head],
    plan: {
      pairs,
      runs: runs ?? loaded.runs ?? 3,
      warmup_runs: warmup,
      warmup_blocks: 1,
      order: 'ABBA',
      install: base.appId === head.appId ? 'sequential' : 'side-by-side',
    },
    decided: false,
    series: [],
    checks: [],
    warnings: [],
  };
  log(`doubletake ${id}: ${device.name} (${device.os}), ${cases.length} case(s), results in ${dir}`);
  const queue = { budgetMs: flags.queue ? ms(flags.queue) : 30 * 60_000, waitedMs: 0 };
  const common = { device, bench: loaded, file: resolve(file), cases, head, runs, dir, experiment, log, queue };
  if (flags.video && !cases.includes(flags.video))
    throw new Error(`--video ${flags.video}: no such case (${cases.join(', ')})`);
  const done =
    command === 'bench'
      ? await runBench({ ...common, base, pairs, warmup, video: flags.video })
      : await runCheck(common);
  out(flags.json ? JSON.stringify(done, null, 2) : summary(done));
  if (done.checks.some((c) => c.refused[loaded.cases[c.case]?.primary ?? '']) || done.refused_cases?.length)
    process.exitCode = 4;
  else if (flags['fail-on-regression'] && done.series.some((s) => s.primary.verdict_kind === 'worse'))
    process.exitCode = 6;
  else if (command === 'bench' && !done.decided) process.exitCode = 5;
}

async function report(ref: string | undefined, flags: Flags): Promise<void> {
  const { dir, experiment } = await loadExperiment(ref ?? 'latest');
  const format = flags.comment ? 'md' : (flags.format ?? 'text');
  const body =
    format === 'json' ? JSON.stringify(experiment, null, 2) : format === 'md' ? card(experiment) : summary(experiment);
  if (!flags.comment) return out(body);
  const file = join(dir, 'card.md');
  await writeFile(file, `${body}\n`);
  const repo = flags.repo ? ['--repo', flags.repo] : [];
  // gh refuses alt text on a video attachment.
  const video = experiment.video ? ['--attach', join(dir, experiment.video)] : [];
  const result = await run('gh', ['pr', 'comment', flags.comment, ...repo, '--body-file', file, ...video]);
  out(result.stdout.trim());
}

async function timeline(ref: string | undefined, flags: Flags): Promise<void> {
  const { dir, experiment } = await loadExperiment(ref ?? 'latest');
  const all = timelines(experiment, await readLaunches(dir)).filter(
    (t) => !flags.case?.length || flags.case.includes(t.case),
  );
  if (!all.length)
    throw new Error(
      `${experiment.id} has no measured launch with marks: set launch.timeline in a case, or have the app write marks`,
    );
  const folder = flags.out ? resolve(flags.out) : dir;
  await mkdir(folder, { recursive: true });
  const files: string[] = [];
  for (const t of all) {
    const file = join(folder, `timeline-${t.case.replace(/[^\w-]+/g, '_')}.svg`);
    await writeFile(file, `${timelineSvg(t)}\n`);
    files.push(file);
  }
  if (flags.format === 'json') return out(JSON.stringify(all, null, 2));
  out(`${all.map((t) => timelineText(t, experiment.device.platform)).join('\n\n')}\n\nSVG: ${files.join(', ')}`);
}

async function bundle(files: (string | undefined)[]): Promise<void> {
  const [headJs, headMap, baseJs, baseMap] = files;
  if (!headJs || !headMap || (baseJs && !baseMap))
    throw new Error('usage: doubletake bundle <bundle.js> <bundle.js.map> [<base.js> <base.js.map>]');
  const head = await readBundle(headJs, headMap);
  const base = baseJs && baseMap ? await readBundle(baseJs, baseMap) : undefined;
  const root = base ? appRoot(head, base) : appRoot(head);
  for (const stats of base ? [head, base] : [head]) groupAppCode(stats, root);
  out(bundleReport(head, base));
}

async function status(): Promise<void> {
  const tools: [string, string, string][] = [
    ['xcrun', 'xcrun', 'iOS Simulator (simctl)'],
    ['python3', '/usr/bin/python3', 'iOS process start times'],
    ['adb', 'adb', 'Android'],
    ['ffmpeg', ffmpegPath(), 'launch.visual and side-by-side video'],
    ['axe', 'axe', 'taps and swipes on the iOS Simulator'],
    ['maestro', 'maestro', 'maestro steps, and Android taps on an element'],
  ];
  out(`doubletake ${pkg.version} · ${await hostLine()}`);
  for (const [name, cmd, what] of tools) out(`  ${(await which(cmd)) ? '✓' : '✗'} ${name.padEnd(8)} ${what}`);
  if (await which('xcrun')) {
    const sims = (await listSimulators()).filter((s) => s.state === 'Booted');
    out(
      `  simulators booted: ${sims.length ? sims.map((s) => `${s.name} (${s.runtime}, ${s.udid})`).join(', ') : 'none'}`,
    );
  }
  if (await which('adb')) {
    const devices = (await run('adb', ['devices'], { check: false })).stdout
      .split('\n')
      .slice(1)
      .filter((l) => l.includes('\tdevice'));
    out(`  android devices: ${devices.length ? devices.map((l) => l.split('\t')[0]).join(', ') : 'none'}`);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true, strict: true });
  const flags: Flags = values;
  const [command, arg, ...rest] = positionals;
  if (flags.version) return out(pkg.version);
  if (flags.help || !command) return out(USAGE);
  if (command === 'bench' || command === 'check') return measure(command, arg, flags);
  if (command === 'report') return report(arg, flags);
  if (command === 'timeline') return timeline(arg, flags);
  if (command === 'status') return status();
  if (command === 'mcp') return serve();
  if (command === 'bundle') return bundle([arg, ...rest]);
  throw new Error(`unknown command ${command}\n\n${USAGE}`);
}

main().catch((error: unknown) => {
  if (error instanceof Refusal) {
    log(`refused (${error.validator}): ${error.message}`);
    process.exitCode = 4;
    return;
  }
  log(`doubletake: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
