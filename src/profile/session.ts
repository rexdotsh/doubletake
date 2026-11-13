import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Bench, Case } from '../bench.ts';
import { type Device, Refusal } from '../device.ts';
import type { FlowState } from '../flow.ts';
import { type RunProfile, runOnce } from '../run.ts';
import { run } from '../sh.ts';
import type { Variant } from '../store.ts';
import { get } from '../util.ts';
import {
  androidReader,
  hookProfiler,
  iosReader,
  metroProfiler,
  sampler,
  simpleperf,
  type Recorder,
} from './capture.ts';
import { diffProfiles } from './diff.ts';
import { flameSvg } from './flame.ts';
import { toCpuProfile } from './hermes.ts';
import { type Profile, type ProfileKind, mean } from './model.ts';
import { type ProfileRefusal, type ProfileResult, side } from './result.ts';
import { deobfuscateProfile, loadR8, r8Classes, sourceMap, symbolicate } from './symbols.ts';

// `--profile`: after a case's timed pairs, profiled pairs in the same alternating order, each block a discarded
// warm-up (as the bench's) and one profiled run, so a profile sees the same warm state as a timed run and never
// shares one.

export type Symbols = { map?: string; r8?: string };

export type ProfileSettings = {
  /** Profiled pairs per case (a check profiles head once). */
  pairs: number;
  /** Metro's URL, for JS on a dev build. */
  metro?: string;
  symbols: Partial<Record<Variant['role'], Symbols>>;
};

export type ProfileOptions = {
  device: Device;
  bench: Bench;
  file: string;
  dir: string;
  log: (line: string) => void;
  settings: ProfileSettings;
  /** Discarded runs before each profiled one (the bench's warm-up; none in a check). */
  warmup: number;
  /** Installs the side's build when it must be, and waits for a quiet host. */
  prepare(v: Variant): Promise<void>;
};

const slug = (name: string) => name.replace(/[^\w-]+/g, '_');

async function executable(v: Variant): Promise<string | undefined> {
  if (!v.artifact) return undefined;
  const out = await run(
    'plutil',
    ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(v.artifact, 'Info.plist')],
    {
      check: false,
    },
  );
  return out.code === 0 ? out.stdout.trim() : undefined;
}

async function recorders(o: ProfileOptions, v: Variant): Promise<Recorder[]> {
  const { device } = o;
  const android = device.platform === 'android';
  const list = [android ? simpleperf(device.id, v.appId) : sampler(await executable(v))];
  const hook = o.bench.profile?.js;
  const file = hook?.file[device.platform];
  if (o.settings.metro) list.push(metroProfiler(o.settings.metro, v.appId, device.name));
  else if (hook && file)
    list.push(
      hookProfiler({ ...hook, file }, android ? androidReader(device.id, v.appId) : iosReader(device.id, v.appId)),
    );
  return list;
}

type Got = Map<ProfileKind, Profile>;

/** The run's profiler hooks; a recorder that refuses to start is dropped for the rest of the case. */
function hooks(live: Recorder[], refused: Map<ProfileKind, string>, raw: (kind: ProfileKind) => string, got: Got) {
  const each = async (what: (r: Recorder) => Promise<void>) => {
    for (const r of live.slice()) {
      try {
        await what(r);
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        refused.set(r.kind, error.message);
        live.splice(live.indexOf(r), 1);
      }
    }
  };
  const profile: RunProfile = {
    start: (state, cold) => each((r) => r.start(state, cold)),
    launched: (state) => each((r) => r.launched(state)),
    stop: (state: FlowState) => each(async (r) => void got.set(r.kind, await r.stop(state, raw(r.kind)))),
  };
  return profile;
}

/** A side's profiles of one kind, symbolicated: JS through its source map, Java frames through its R8 mapping. */
async function symbolicated(profiles: Profile[], kind: ProfileKind, s: Symbols, label: string): Promise<Profile[]> {
  if (kind === 'js') {
    if (!profiles.some((p) => p.frames.some((f) => f.at))) return profiles;
    if (!s.map) return profiles.map((p) => ({ ...p, notes: [...p.notes, `no source map for ${label}: bundle names`] }));
    const map = sourceMap(JSON.parse(await readFile(s.map, 'utf8')));
    return profiles.map((p) => symbolicate(p, map));
  }
  if (!s.r8) return profiles;
  const r8 = await loadR8(s.r8, r8Classes(profiles));
  return profiles.map((p) => deobfuscateProfile(p, r8));
}

/** Profiles one case: `pairs` alternating profiled blocks per side (one side for a check). */
export async function profileCase(
  o: ProfileOptions,
  name: string,
  c: Case,
  sides: Variant[],
): Promise<{ results: ProfileResult[]; refusals: ProfileRefusal[] }> {
  const folder = join(o.dir, 'profiles', slug(name));
  await mkdir(folder, { recursive: true });
  const live = new Map(await Promise.all(sides.map(async (v) => [v.role, await recorders(o, v)] as const)));
  const refused = new Map<ProfileKind, string>();
  const runs = new Map<string, Profile[]>();
  const pairs = sides.length > 1 ? o.settings.pairs : 1;
  for (let i = 0; i < pairs; i++) {
    for (const v of i % 2 === 0 ? sides : sides.toReversed()) {
      o.log(`${name}: profiling ${v.label} (pair ${i + 1} of ${pairs})`);
      await o.prepare(v);
      const tap = await o.device.logs(v.appId);
      const got: Got = new Map();
      try {
        const offset = await o.device.clockOffset();
        const ctx = { device: o.device, appId: v.appId, bench: o.bench, case: c, tap, offset, dir: dirname(o.file) };
        for (let w = 0; w < o.warmup; w++) await runOnce(ctx);
        const raw = (kind: ProfileKind) => join(folder, `p${i}-${v.role}-${kind}`);
        await runOnce({ ...ctx, profile: hooks(live.get(v.role) ?? [], refused, raw, got) });
      } finally {
        await tap.stop();
        await o.device.terminate(v.appId);
      }
      for (const [kind, p] of got) {
        const key = `${kind}\u0000${v.role}`;
        runs.set(key, [...(runs.get(key) ?? []), p]);
      }
    }
  }
  const results: ProfileResult[] = [];
  for (const kind of ['native', 'js'] as const) {
    const recorded = sides.map((v) => runs.get(`${kind}\u0000${v.role}`) ?? []);
    if (recorded.some((list) => list.length !== pairs)) continue;
    const per = await Promise.all(
      sides.map((v, j) => symbolicated(get(recorded, j), kind, o.settings.symbols[v.role] ?? {}, v.label)),
    );
    const result: ProfileResult = { case: name, kind, profiler: get(get(per, 0), 0).profiler, sides: [], notes: [] };
    for (const [j, v] of sides.entries()) {
      const avg = mean(get(per, j));
      if (!avg) continue;
      const flame = join('profiles', slug(name), `${kind}-${v.role}.svg`);
      await writeFile(join(o.dir, flame), flameSvg(avg, `${name} · ${v.label} · ${kind}`));
      await writeFile(join(folder, `${kind}-${v.role}.cpuprofile`), JSON.stringify(toCpuProfile(avg)));
      result.sides.push(side(avg, { role: v.role, label: v.label, runs: pairs, flame }));
      result.notes.push(...avg.notes.map((n) => `${v.label}: ${n}`));
    }
    const [base, head] = per;
    if (base && head && sides.length === 2) result.diff = diffProfiles(base.map((b, k) => [b, get(head, k)]));
    results.push(result);
  }
  return { results, refusals: [...refused].map(([kind, reason]) => ({ case: name, kind, reason })) };
}
