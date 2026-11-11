import { access } from 'node:fs/promises';
import { run } from './sh.ts';
import { ffmpegPath } from './visual.ts';

export type Clip = {
  file: string;
  label: string;
  /** Seconds to skip at the start (the launch's first change). */ start: number;
  seconds: number;
};

const FONTS = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];

async function font(): Promise<string | undefined> {
  for (const f of FONTS)
    if (
      await access(f).then(
        () => true,
        () => false,
      )
    )
      return f;
  return undefined;
}

const escape = (text: string) =>
  text.replaceAll('\\', '').replaceAll("'", '’').replaceAll(':', '\\:').replaceAll('%', '\\%');

/**
 * Two clips side by side from their own t = 0 (each trimmed to its first change), the shorter one holding its
 * last frame, with a label over each and one shared timer when this ffmpeg has drawtext.
 */
export async function sideBySide(left: Clip, right: Clip, out: string): Promise<void> {
  const ffmpeg = ffmpegPath();
  const filters = (await run(ffmpeg, ['-hide_banner', '-filters'], { check: false })).stdout;
  const fontfile = filters.includes('drawtext') ? await font() : undefined;
  const length = Math.max(left.seconds - left.start, right.seconds - right.start) + 0.5;
  const side = (i: number, clip: Clip) => {
    const base = `[${i}:v]trim=start=${clip.start.toFixed(3)},setpts=PTS-STARTPTS,fps=30,scale=540:-2,tpad=stop_mode=clone:stop_duration=${length.toFixed(2)},trim=duration=${length.toFixed(2)},pad=iw:ih+90:0:90:color=black`;
    return fontfile
      ? `${base},drawtext=fontfile=${fontfile}:text='${escape(clip.label)}':fontcolor=white:fontsize=34:x=(w-tw)/2:y=26[s${i}]`
      : `${base}[s${i}]`;
  };
  const timer = fontfile
    ? `,pad=iw:ih+80:0:0:color=black,drawtext=fontfile=${fontfile}:text='t = %{eif\\:trunc(t)\\:d}.%{eif\\:trunc(mod(t\\,1)*100)\\:d\\:2} s':fontcolor=white:fontsize=40:x=(w-tw)/2:y=h-62`
    : '';
  const graph = `${side(0, left)};${side(1, right)};[s0][s1]hstack=inputs=2${timer}[v]`;
  await run(ffmpeg, [
    '-y',
    '-loglevel',
    'error',
    '-i',
    left.file,
    '-i',
    right.file,
    '-filter_complex',
    graph,
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '23',
    '-movflags',
    '+faststart',
    out,
  ]);
}
