import { spawn } from 'node:child_process';
import { Refusal } from './device.ts';
import { get } from './util.ts';

export type Region = [x: number, y: number, w: number, h: number];

const WIDTH = 72;
const HEIGHT = 156;
const FPS = 60;
/** A pixel changed when its gray level moved this much; a frame changed when over 1% of pixels did. */
const LEVEL = 24;
const SHARE = 0.01;

export function ffmpegPath(): string {
  return process.env.DOUBLETAKE_FFMPEG ?? 'ffmpeg';
}

/** Decodes a video to small gray frames at a constant 60 fps (variable-rate frames are repeated). */
export function decodeFrames(file: string): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `fps=${FPS},scale=${WIDTH}:${HEIGHT},format=gray`,
      '-f',
      'rawvideo',
      '-',
    ];
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not decode ${file}: ${stderr.trim()}`));
      const all = Buffer.concat(chunks);
      const size = WIDTH * HEIGHT;
      const frames: Uint8Array[] = [];
      for (let at = 0; at + size <= all.length; at += size) frames.push(all.subarray(at, at + size));
      resolve(frames);
    });
  });
}

function mask(ignore: readonly Region[]): Uint8Array {
  const keep = new Uint8Array(WIDTH * HEIGHT).fill(1);
  for (const [x, y, w, h] of ignore)
    for (let row = Math.floor(y * HEIGHT); row < Math.min(HEIGHT, Math.ceil((y + h) * HEIGHT)); row++)
      for (let col = Math.floor(x * WIDTH); col < Math.min(WIDTH, Math.ceil((x + w) * WIDTH)); col++)
        keep[row * WIDTH + col] = 0;
  return keep;
}

function changed(a: Uint8Array, b: Uint8Array, keep: Uint8Array): boolean {
  let count = 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    if (!keep[i]) continue;
    total++;
    if (Math.abs(get(a, i) - get(b, i)) > LEVEL) count++;
  }
  return count > total * SHARE;
}

export type Visual = { first: number; complete: number; frames: number };

export const VIDEO_FPS = FPS;

/**
 * From the first frame after `from` (ms into the video: the launch command) that differs from the frame at
 * `from`, to the frame after which every frame stays within 1% of the last one (visually complete). Times in
 * ms from the start of the video. `tail` is how long the screen must stay unchanged at the end to stand.
 */
export function visualTimes(
  frames: readonly Uint8Array[],
  ignore: readonly Region[] = [],
  tail = 1000,
  from = 0,
): Visual {
  const keep = mask(ignore);
  const origin = Math.max(0, Math.min(frames.length - 1, Math.round((from * FPS) / 1000)));
  const start = frames[origin];
  const end = frames.at(-1);
  if (!start || !end) throw new Refusal('NoVideo', 'the recording has no frames');
  const first = frames.findIndex((f, i) => i >= origin && changed(f, start, keep));
  if (first < 0) throw new Refusal('NoVisualChange', 'the screen never changed in the recording');
  let complete = frames.length - 1;
  while (complete > first && !changed(get(frames, complete - 1), end, keep)) complete--;
  const stable = ((frames.length - 1 - complete) * 1000) / FPS;
  if (stable < tail)
    throw new Refusal(
      'NotSettled',
      `the screen was still changing ${Math.round(stable)} ms before the recording ended: give the case a longer hold, or ignore the animating region`,
    );
  return { first: (first * 1000) / FPS, complete: (complete * 1000) / FPS, frames: frames.length };
}
