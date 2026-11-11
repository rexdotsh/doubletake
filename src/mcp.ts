import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import pkg from '../package.json' with { type: 'json' };
import { isRecord } from './util.ts';

// A stdio MCP server whose tools are the CLI's commands: same names, same flags, the CLI's own output.
// Each call runs the CLI as a child, so a bench that takes minutes never blocks the server's reads.

type Tool = { name: string; description: string; flags: Record<string, string>; positional?: string };

const TOOLS: Tool[] = [
  {
    name: 'status',
    description: 'What this machine can measure: simulators, emulators, ffmpeg, axe, maestro.',
    flags: {},
  },
  {
    name: 'check',
    description: 'Run each case of a bench file once on one build: does it work, what does it read?',
    positional: 'file',
    flags: {
      head: 'the build: .app, .apk or installed:<id>',
      case: 'only this case',
      platform: 'ios or android',
      device: 'udid, name or serial',
      host: 'ssh command of the machine with the device',
      'host-init': 'shell run first on the host',
    },
  },
  {
    name: 'bench',
    description:
      'A/B two builds in alternating pairs and give a verdict per case (minutes). Returns the experiment record.',
    positional: 'file',
    flags: {
      base: 'the before build',
      head: 'the after build',
      case: 'only this case',
      pairs: 'auto or a number',
      runs: 'measured runs per block',
      labels: 'base,head names',
      platform: 'ios or android',
      device: 'udid, name or serial',
      video: 'film this case side by side',
      host: 'ssh command of the machine with the device',
      'host-init': 'shell run first on the host',
    },
  },
  {
    name: 'report',
    description: 'An experiment as text, the markdown PR card (format md) or JSON.',
    positional: 'experiment',
    flags: { format: 'text, md or json' },
  },
];

function schema(tool: Tool) {
  const properties: Record<string, { type: 'string'; description: string }> = {};
  if (tool.positional)
    properties[tool.positional] = {
      type: 'string',
      description: tool.positional === 'file' ? 'path of the bench file' : 'experiment id, or latest',
    };
  for (const [flag, description] of Object.entries(tool.flags)) properties[flag] = { type: 'string', description };
  return { type: 'object', properties, required: tool.positional === 'file' ? ['file'] : [] };
}

function cli(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1] ?? '', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('close', (code) =>
      resolve({ code: code ?? 1, out: code === 0 ? out : `${out}${err.split('\n').slice(-20).join('\n')}` }),
    );
  });
}

// One device-driving command at a time: two benches on one simulator would install over and stop each other.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

async function call(name: string, input: Record<string, unknown>): Promise<{ text: string; error: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `unknown tool ${name}`, error: true };
  const args: string[] = [name];
  const text = (key: string) => {
    const v = input[key];
    return typeof v === 'string' ? v : undefined;
  };
  const positional = tool.positional ? text(tool.positional) : undefined;
  if (positional) args.push(positional);
  for (const flag of Object.keys(tool.flags)) {
    const v = text(flag);
    if (v) args.push(`--${flag}`, v);
  }
  if (name === 'bench' || name === 'check') args.push('--json');
  const { code, out } = name === 'bench' || name === 'check' ? await serialized(() => cli(args)) : await cli(args);
  return { text: out.trim(), error: code !== 0 && code !== 5 };
}

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

export function serve(): void {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
      );
      return;
    }
    if (!isRecord(message) || message.id === undefined) return;
    const { id, method } = message;
    const params = isRecord(message.params) ? message.params : {};
    if (method === 'initialize')
      reply(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'doubletake', version: pkg.version },
      });
    else if (method === 'ping') reply(id, {});
    else if (method === 'tools/list')
      reply(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: schema(t) })) });
    else if (method === 'tools/call') {
      const input = isRecord(params.arguments) ? params.arguments : {};
      void call(String(params.name), input).then(({ text, error }) =>
        reply(id, { content: [{ type: 'text', text }], isError: error }),
      );
    } else
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${String(method)}` } })}\n`,
      );
  });
}
