import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Action, type Point, isPoint } from './device.ts';
import { run, which } from './sh.ts';

/**
 * Runs a Maestro flow file on a device: the `maestro` step, and Android taps by text (adb has no selector).
 * iOS input goes through AXe instead. Maestro's own startup (seconds) lands in whatever window holds it.
 */
export async function maestro(device: string, file: string, env: Record<string, string> = {}): Promise<void> {
  const bin = await which('maestro');
  if (!bin)
    throw new Error(
      'maestro is not on PATH: install it (https://maestro.mobile.dev) for maestro steps and Android taps by text',
    );
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

const regex = (text: string) => JSON.stringify(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const xy = ([x, y]: [number, number]) => `"${Math.round(x)},${Math.round(y)}"`;

/**
 * Taps and swipes as Maestro commands. `px` turns a point into pixels. Element taps match the whole id or text;
 * `index` counts in Maestro's order of the matches.
 */
export function maestroCommands(actions: readonly Action[], px: (at: Point) => [number, number]): string[] {
  return actions.map((a) => {
    if ('swipe' in a)
      return `swipe:\n    start: ${xy(px(a.swipe.from))}\n    end: ${xy(px(a.swipe.to))}\n    duration: ${a.swipe.duration}`;
    if (isPoint(a.tap)) return `tapOn:\n    point: ${xy(px(a.tap))}`;
    const t = typeof a.tap === 'string' ? { label: a.tap } : a.tap;
    const by = 'id' in t ? `id: ${regex(t.id)}` : `text: ${regex(t.label)}`;
    return `tapOn:\n    ${by}${t.index === undefined ? '' : `\n    index: ${t.index}`}`;
  });
}
