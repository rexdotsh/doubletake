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

/** A flash: near-white (or near-black) share rising by this much and falling back within FLASH_MS. */
const FLASH_RISE = 0.25;
const FLASH_MS = 300;
const WHITE = 200;
const BLACK = 30;
/** Edge strips, as a share of the frame's width or height: a flash often shows only as a border. */
const EDGE = 0.04;
/** An edge flash fills its strip; a bright button sliding through one only crosses part of it. */
const EDGE_FILL = 0.8;
/** A change after the screen held still this long is a jump: a layout shift or content popping in late. */
const STILL_MS = 300;
const SETTLE_MS = 500;

/** `ms`: how long a flash lasted, or how long the screen held still before a jump. */
type TransitionEvent = { kind: 'flash-white' | 'flash-black' | 'jump'; at: number; ms: number };
/** `settled`: the screen held still for SETTLE_MS before the recording ended; freeze and jumps need it. */
export type Transition = {
  flashes: number;
  freeze: number;
  jumps: number;
  settled: boolean;
  events: TransitionEvent[];
};

const at = (frame: number) => (frame * 1000) / FPS;

/** Share of kept pixels above (or below) a gray level, per frame, in one region. */
function shares(frames: readonly Uint8Array[], keep: Uint8Array, region: Region, test: (v: number) => boolean) {
  const [x, y, w, h] = region;
  const cols = [Math.floor(x * WIDTH), Math.min(WIDTH, Math.ceil((x + w) * WIDTH))] as const;
  const rows = [Math.floor(y * HEIGHT), Math.min(HEIGHT, Math.ceil((y + h) * HEIGHT))] as const;
  return frames.map((f) => {
    let hit = 0;
    let total = 0;
    for (let row = rows[0]; row < rows[1]; row++)
      for (let col = cols[0]; col < cols[1]; col++) {
        const i = row * WIDTH + col;
        if (!keep[i]) continue;
        total++;
        if (test(get(f, i))) hit++;
      }
    return total ? hit / total : 0;
  });
}

/** Spikes in a share series: a rise of FLASH_RISE over the frame before, to at least `fill`, that falls back within FLASH_MS. */
function spikes(series: readonly number[], fill = 0): { at: number; frames: number }[] {
  const window = Math.round((FLASH_MS * FPS) / 1000);
  const found: { at: number; frames: number }[] = [];
  for (let i = 1; i < series.length; i++) {
    const before = get(series, i - 1);
    if (get(series, i) < Math.max(before + FLASH_RISE, fill)) continue;
    const back = series.findIndex((v, j) => j > i && j <= i + window && v <= before + FLASH_RISE / 3);
    if (back < 0) continue;
    found.push({ at: i, frames: back - i });
    i = back;
  }
  return found;
}

/**
 * What a screen transition looked like, from a recording of it: white or black flashes (whole frame or an edge
 * strip), the longest the screen held still between its first change and visually complete (a freeze), and jumps
 * (it changed again after holding still for STILL_MS). Times in ms from the start of the video.
 */
export function transition(frames: readonly Uint8Array[], ignore: readonly Region[] = []): Transition {
  const keep = mask(ignore);
  const start = frames[0];
  const end = frames.at(-1);
  if (!start || !end) throw new Refusal('NoVideo', 'the recording has no frames');
  const events: TransitionEvent[] = [];
  const regions: Region[] = [
    [0, 0, 1, 1],
    [0, 0, EDGE, 1],
    [1 - EDGE, 0, EDGE, 1],
    [0, 0, 1, EDGE],
    [0, 1 - EDGE, 1, EDGE],
  ];
  for (const [kind, test] of [
    ['flash-white', (v: number) => v > WHITE],
    ['flash-black', (v: number) => v < BLACK],
  ] as const) {
    const seen: { at: number; region: number }[] = [];
    for (const [r, region] of regions.entries())
      for (const s of spikes(shares(frames, keep, region, test), r === 0 ? 0 : EDGE_FILL)) {
        // The same flash read in another region (the whole frame and an edge) counts once.
        if (seen.some((x) => x.region !== r && Math.abs(x.at - s.at) <= 2)) continue;
        seen.push({ at: s.at, region: r });
        events.push({ kind, at: at(s.at), ms: at(s.frames) });
      }
  }
  const first = frames.findIndex((f) => changed(f, start, keep));
  if (first < 0)
    throw new Refusal(
      'NoVisualChange',
      'the screen never changed in the recording: did the step meant to move it miss?',
    );
  let freeze = 0;
  let complete = frames.length - 1;
  while (complete > first && !changed(get(frames, complete - 1), end, keep)) complete--;
  // Against the still stretch's first frame, so a slow fade (small steps per frame) still reads as motion.
  let anchor = first;
  for (let i = first + 1; i <= complete; i++) {
    if (!changed(get(frames, i), get(frames, anchor), keep)) continue;
    const held = at(i - anchor);
    freeze = Math.max(freeze, held);
    if (held >= STILL_MS) events.push({ kind: 'jump', at: at(i), ms: held });
    anchor = i;
  }
  events.sort((a, b) => a.at - b.at);
  return {
    flashes: events.filter((e) => e.kind.startsWith('flash')).length,
    freeze,
    jumps: events.filter((e) => e.kind === 'jump').length,
    settled: at(frames.length - 1 - complete) >= SETTLE_MS,
    events,
  };
}

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
