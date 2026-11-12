import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './sh.ts';
import { home } from './store.ts';

// --host runs the whole command on the machine with the simulator or emulator: SSH never sits between a
// launch and its timestamps. The CLI (one bundled file), the bench file's folder and the builds go over,
// the experiment comes back.

export type Host = { ssh: string; init?: string };

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const REMOTE = '.doubletake';

function sh(
  host: Host,
  command: string,
  io: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; inherit?: boolean } = {},
): Promise<number> {
  const full = host.init ? `${host.init} >/dev/null 2>&1; ${command}` : command;
  return new Promise((done, reject) => {
    const child = spawn('sh', ['-c', `${host.ssh} "$1"`, 'sh', full], {
      stdio: [io.stdin ? 'pipe' : 'ignore', io.stdout ? 'pipe' : io.inherit ? 'inherit' : 'ignore', 'inherit'],
    });
    // An ssh that exits early closes its stdin: the exit code reports that, not an unhandled EPIPE.
    child.stdin?.on('error', () => undefined);
    if (io.stdin && child.stdin) io.stdin.pipe(child.stdin);
    if (io.stdout && child.stdout) child.stdout.pipe(io.stdout);
    child.on('error', reject);
    child.on('close', (code) => done(code ?? 1));
  });
}

async function shOk(host: Host, command: string, io: Parameters<typeof sh>[2] = {}): Promise<void> {
  const code = await sh(host, command, io);
  if (code !== 0) throw new Error(`on ${host.ssh}: \`${command.slice(0, 120)}\` exited ${code}`);
}

/** Sends a local file or folder as `name` under `remoteDir` (tar over the SSH command). */
async function send(host: Host, local: string, remoteDir: string, name: string): Promise<void> {
  const tar = spawn('tar', ['-czf', '-', '-C', dirname(local), basename(local)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const rename = basename(local) === name ? '' : ` && rm -rf ${q(name)} && mv ${q(basename(local))} ${q(name)}`;
  await shOk(host, `mkdir -p ${q(remoteDir)} && cd ${q(remoteDir)} && tar -xzf -${rename}`, { stdin: tar.stdout });
}

async function hashPath(path: string, hash = createHash('sha256')): Promise<string> {
  const info = await stat(path);
  if (info.isDirectory()) {
    for (const entry of (await readdir(path)).toSorted()) {
      hash.update(entry);
      await hashPath(join(path, entry), hash);
    }
  } else hash.update(await readFile(path));
  return hash.copy().digest('hex').slice(0, 16);
}

/** Uploads a build once per content hash; returns its path on the host, relative to the remote home. */
export async function sendArtifact(host: Host, local: string): Promise<string> {
  const dir = `${REMOTE}/artifacts/${await hashPath(local)}`;
  const path = `${dir}/${basename(local)}`;
  if ((await sh(host, `test -e ${q(path)}`)) === 0) return path;
  // Upload into a staging folder and publish it with one rename, so an interrupted upload is never a cache hit.
  const staging = `${REMOTE}/artifacts/.staging-${process.pid}-${Date.now()}`;
  await send(host, local, staging, basename(local));
  await shOk(host, `mkdir -p ${q(dir)} && mv ${q(`${staging}/${basename(local)}`)} ${q(path)} && rm -rf ${q(staging)}`);
  return path;
}

/** The CLI as one file: this bundle, or one built from source with bun. */
async function bundle(): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const self = fileURLToPath(import.meta.url);
  if (self.endsWith('.mjs')) return { file: self, cleanup: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), 'doubletake-'));
  const file = join(dir, 'doubletake.mjs');
  await run('bun', ['build', join(dirname(self), 'cli.ts'), '--target=node', '--outfile', file]);
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export type RemoteRun = {
  /** The command and its arguments, with local paths already replaced by `paths`. */
  args: (benchPath: string) => string[];
  bench: string;
  id: string;
};

/** Runs a doubletake command on the host and copies its experiment back; false when no record came back. */
export async function runRemote(host: Host, r: RemoteRun): Promise<boolean> {
  const work = `${REMOTE}/runs/${r.id}`;
  const cli = await bundle();
  try {
    await send(host, cli.file, work, 'doubletake.mjs');
  } finally {
    await cli.cleanup();
  }
  const benchDir = dirname(resolve(r.bench));
  await send(host, benchDir, work, 'bench');
  const bench = `${work}/bench/${relative(benchDir, resolve(r.bench))}`;
  // The host prints its progress on stderr; its summary is printed here, from the copied record.
  const command = `${['node', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', `${work}/doubletake.mjs`, ...r.args(bench)].map(q).join(' ')} >/dev/null`;
  const code = await sh(host, command, { inherit: true });
  let fetched = true;
  try {
    await fetchExperiment(host, r.id);
  } catch (error) {
    if (code === 0) throw error;
    fetched = false;
  } finally {
    await sh(host, `rm -rf ${q(work)}`);
  }
  if (code !== 0) process.exitCode = code;
  return fetched;
}

async function fetchExperiment(host: Host, id: string): Promise<void> {
  const local = join(home(), 'experiments');
  await mkdir(local, { recursive: true });
  const untar = spawn('tar', ['-xzf', '-', '-C', local], { stdio: ['pipe', 'ignore', 'inherit'] });
  untar.stdin.on('error', () => undefined);
  const untarred = new Promise<number>((done) => untar.on('close', (status) => done(status ?? 1)));
  const sent = await sh(host, `cd ${REMOTE}/experiments && COPYFILE_DISABLE=1 tar -czf - ${q(id)}`, {
    stdout: untar.stdin,
  });
  if (sent !== 0 || (await untarred) !== 0) throw new Error(`could not copy ${id} back from the host`);
}
