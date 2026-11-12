import { type ChildProcess, spawn } from 'node:child_process';

export type Result = { code: number; stdout: string; stderr: string };

/** Runs a command to its exit. Throws on a nonzero exit unless `check` is false. */
export function run(
  cmd: string,
  args: readonly string[],
  options: { check?: boolean; timeout?: number; input?: string; cwd?: string } = {},
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = options.timeout ? setTimeout(() => child.kill('SIGKILL'), options.timeout) : undefined;
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${cmd}: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const result = { code: code ?? (signal ? 128 : 1), stdout, stderr };
      if (options.check !== false && result.code !== 0) {
        const why = stderr.trim() || stdout.trim() || (signal ? `killed by ${signal}` : `exit ${result.code}`);
        reject(new Error(`${cmd} ${args.join(' ')}: ${why.split('\n').slice(-5).join('\n')}`));
      } else resolve(result);
    });
    // A command that exits without reading its input (missing, or done early) closes the pipe: not an error.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}

/** Starts a long-running command and hands each stdout line to `onLine`. */
export function stream(cmd: string, args: readonly string[], onLine: (line: string) => void): ChildProcess {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
  child.stderr?.resume();
  return child;
}

export function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGINT'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill(signal);
  });
}

export async function which(cmd: string): Promise<string | null> {
  const result = await run('sh', ['-c', `command -v "$1"`, 'sh', cmd], { check: false });
  return result.code === 0 ? result.stdout.trim() : null;
}

export const sleep = (duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration));
