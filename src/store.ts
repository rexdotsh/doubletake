import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Platform } from './metrics.ts';
import type { Comparison } from './stats.ts';
import { isRecord } from './util.ts';

export type Variant = {
  role: 'base' | 'head';
  /** What reports call this side. */
  label: string;
  /** The .app or .apk installed for this side; absent when the app is already installed. */
  artifact?: string;
  appId: string;
  /** What the user passed. */
  spec: string;
};

export type Series = {
  case: string;
  primary: Comparison;
  secondaries: Comparison[];
  refused: Record<string, string>;
  /** The metrics the case declared (primary and metrics): the only refusals reports list. */
  declared?: string[];
  pairs: number;
  stopped: string;
  minutes: number;
};

type Check = { case: string; values: Record<string, number>; refused: Record<string, string> };

/** A strobe-shaped experiment record: `id`, `kind`, `created`, `variants`, `series[].primary` match result.v1.json. */
export type Experiment = {
  schema: 'doubletake.experiment.v1';
  id: string;
  kind: 'experiment' | 'check';
  created: string;
  file: string;
  comparison: 'builds';
  device: { platform: Platform; name: string; os: string; id: string; host: string };
  variants: Variant[];
  plan: {
    pairs: number | 'auto';
    runs: number;
    warmup_runs: number;
    warmup_blocks: number;
    order: 'ABBA';
    install: 'side-by-side' | 'sequential';
  };
  decided: boolean;
  series: Series[];
  checks: Check[];
  warnings: string[];
  video?: string;
};

export function home(): string {
  return process.env.DOUBLETAKE_HOME ?? join(homedir(), '.doubletake');
}

export function newId(prefix: 'exp' | 'rec'): string {
  return `${prefix}_${randomBytes(3).toString('hex')}`;
}

export function experimentDir(id: string): string {
  return join(home(), 'experiments', id);
}

export async function saveExperiment(dir: string, experiment: Experiment): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'result.json');
  await writeFile(`${file}.tmp`, `${JSON.stringify(experiment, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

function isExperiment(value: unknown): value is Experiment {
  return isRecord(value) && value.schema === 'doubletake.experiment.v1' && typeof value.id === 'string';
}

async function readExperiment(dir: string): Promise<Experiment | undefined> {
  const parsed: unknown = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8').catch(() => '{}'));
  return isExperiment(parsed) ? parsed : undefined;
}

/** Finds an experiment by id, unique id prefix, `latest`, or a result.json path. */
export async function loadExperiment(ref: string): Promise<{ dir: string; experiment: Experiment }> {
  let dir = ref.endsWith('.json') ? dirname(ref) : undefined;
  if (!dir) {
    const ids = await readdir(join(home(), 'experiments')).catch((): string[] => []);
    const found = await Promise.all(
      ids.map(async (id) => ({ id, created: (await readExperiment(experimentDir(id)))?.created ?? '' })),
    );
    const match =
      ref === 'latest'
        ? found.toSorted((a, b) => b.created.localeCompare(a.created)).slice(0, 1)
        : found.filter((f) => f.id.startsWith(ref));
    const [only] = match;
    if (!only || match.length > 1)
      throw new Error(
        match.length ? `${ref} matches ${match.length} experiments` : `no experiment ${ref} in ${home()}`,
      );
    dir = experimentDir(only.id);
  }
  const experiment = await readExperiment(dir);
  if (!experiment) throw new Error(`${join(dir, 'result.json')} is not a doubletake experiment`);
  return { dir, experiment };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Takes the device for one bench at a time across processes (exclusive create); returns the release. */
export async function lockDevice(device: string): Promise<() => Promise<void>> {
  const dir = join(home(), 'locks');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${device.replace(/[^\w.-]/g, '_')}.pid`);
  const mine = String(process.pid);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, mine, { flag: 'wx' });
      return async () => {
        if ((await readFile(file, 'utf8').catch(() => '')) === mine) await rm(file, { force: true });
      };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const holder = Number(await readFile(file, 'utf8').catch(() => ''));
      if (holder && alive(holder))
        throw new Error(`device ${device} is in use by doubletake (pid ${holder}): one bench per device at a time`);
      // A dead holder's lock: remove it by renaming (atomic), so two takers cannot both delete and create.
      await rename(file, `${file}.stale-${mine}`).catch(() => undefined);
      await rm(`${file}.stale-${mine}`, { force: true });
    }
  }
  throw new Error(`could not take the lock for device ${device}`);
}
