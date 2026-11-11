import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
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
  declared: string[];
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
