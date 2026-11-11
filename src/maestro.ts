import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, which } from './sh.ts';

/** Runs a Maestro flow file on a device. Maestro's own startup (seconds) lands in whatever window holds it. */
export async function maestro(device: string, file: string, env: Record<string, string> = {}): Promise<void> {
  const bin = await which('maestro');
  if (!bin)
    throw new Error('maestro is not on PATH: install it (https://maestro.mobile.dev) for tap, swipe and maestro steps');
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  await run(bin, ['--device', device, 'test', ...envArgs, file], { timeout: 300_000 });
}

/** Runs Maestro commands given inline, through a temporary flow file. */
export async function maestroInline(device: string, appId: string, commands: string[]): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'doubletake-'));
  try {
    const file = join(dir, 'step.yaml');
    await writeFile(file, `appId: ${appId}\n---\n${commands.map((c) => `- ${c}`).join('\n')}\n`);
    await maestro(device, file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fmt = (v: number) => (v <= 1 ? `${Math.round(v * 100)}%` : String(Math.round(v)));

/** A point for Maestro: fractions of the screen become percentages, larger numbers stay pixels. */
export function pointArg(at: [number, number]): string {
  return `"${fmt(at[0])},${fmt(at[1])}"`;
}
