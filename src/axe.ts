import { type Action, type Point, type Target, isPoint } from './device.ts';
import { run, sleep } from './sh.ts';
import { dig, isRecord } from './util.ts';

// iOS Simulator input through AXe (https://github.com/cameroncooke/AXe). Coordinates are points.

/** One element of AXe's accessibility tree. `prompt`: inside a system alert or sheet. */
export type Element = {
  type: string;
  label: string;
  id: string;
  frame: { x: number; y: number; w: number; h: number };
  prompt: boolean;
};

/**
 * Flattens `axe describe-ui`. While a system prompt is up, AXe reads SpringBoard instead of the app: an
 * application element without a label, with the prompt as an Alert or Sheet in it.
 */
export function parseTree(tree: unknown): { system: boolean; elements: Element[] } {
  const elements: Element[] = [];
  const walk = (node: unknown, prompt: boolean) => {
    if (!isRecord(node)) return;
    const type = typeof node.type === 'string' ? node.type : '';
    const inPrompt = prompt || type === 'Alert' || type === 'Sheet';
    const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => dig(node, 'frame', k));
    if (typeof x === 'number' && typeof y === 'number' && typeof w === 'number' && typeof h === 'number')
      elements.push({
        type,
        label: typeof node.AXLabel === 'string' ? node.AXLabel : '',
        id: typeof node.AXUniqueId === 'string' ? node.AXUniqueId : '',
        frame: { x, y, w, h },
        prompt: inPrompt,
      });
    if (Array.isArray(node.children)) for (const child of node.children) walk(child, inPrompt);
  };
  const roots = Array.isArray(tree) ? tree : [];
  for (const root of roots) walk(root, false);
  const first = roots[0];
  const label = dig(first, 'AXLabel');
  const system = dig(first, 'type') === 'Application' && (typeof label === 'string' ? label : '').trim() === '';
  return { system, elements };
}

/** Elements with this id or label, top to bottom, then left to right. */
export function find(elements: readonly Element[], target: Exclude<Target, string>): Element[] {
  return elements
    .filter((e) => ('id' in target ? e.id === target.id : e.label === target.label))
    .toSorted((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
}

/** The system prompt in front, if any: its text and its buttons. */
export function promptOf(tree: { system: boolean; elements: readonly Element[] }) {
  if (!tree.system) return undefined;
  const inPrompt = tree.elements.filter((e) => e.prompt);
  if (!inPrompt.length) return undefined;
  return {
    text: inPrompt.find((e) => e.type === 'StaticText')?.label ?? '',
    buttons: inPrompt.filter((e) => e.type === 'Button'),
  };
}

const center = (e: Element): [number, number] => [e.frame.x + e.frame.w / 2, e.frame.y + e.frame.h / 2];

/** A point in points, from fractions of the screen or points. */
export function inPoints(at: Point, screen: { w: number; h: number }): [number, number] {
  return Array.isArray(at) ? [at[0] * screen.w, at[1] * screen.h] : at.points;
}

export function axe(bin: string, udid: string) {
  const read = async () => parseTree(JSON.parse((await run(bin, ['describe-ui', '--udid', udid])).stdout));
  const tapAt = ([x, y]: [number, number]) =>
    run(bin, ['tap', '-x', String(Math.round(x)), '-y', String(Math.round(y)), '--udid', udid]);

  /** Taps the first of `buttons` a system prompt offers, until no prompt covers the app; at most 3 prompts. */
  async function clearPrompts(buttons: readonly string[]): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const prompt = promptOf(await read());
      if (!prompt) return;
      const button = buttons.flatMap((b) => prompt.buttons.filter((e) => e.label === b))[0];
      if (!button)
        throw new Error(
          `a system prompt covers the app ("${prompt.text}", buttons: ${prompt.buttons.map((b) => b.label).join(', ')}): add the button to tap to the bench's alerts`,
        );
      await tapAt(center(button));
      await sleep(500);
    }
  }

  async function tapTarget(target: Target, alerts: readonly string[]): Promise<void> {
    const t = typeof target === 'string' ? { label: target } : target;
    if (t.index === undefined) {
      const flag = 'id' in t ? ['--id', t.id] : ['--label', t.label];
      await run(bin, ['tap', ...flag, '--wait-timeout', '10', '--udid', udid]).catch(async (error: unknown) => {
        if (promptOf(await read())) await clearPrompts(alerts);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n(when several elements match, pick one with index: 0 is the first, top to bottom)`,
        );
      });
      return;
    }
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = find((await read()).elements, t);
      const element = found[t.index];
      if (element) return void (await tapAt(center(element)));
      if (Date.now() > deadline)
        throw new Error(
          `${'id' in t ? `id ${t.id}` : `label ${t.label}`}: ${found.length} match(es), no index ${t.index}`,
        );
      await sleep(250);
    }
  }

  return {
    /** The screen in points, from the tree's first element. */
    async screen(): Promise<{ w: number; h: number }> {
      const [first] = (await read()).elements;
      if (!first) throw new Error('axe describe-ui gave no screen frame');
      return { w: first.frame.w, h: first.frame.h };
    },

    /** After `simctl openurl`: accepts iOS's "Open in …?" prompt when it shows within 3 s. */
    async acceptOpen(): Promise<void> {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const open = promptOf(await read())?.buttons.find((b) => b.label === 'Open');
        if (open) return void (await tapAt(center(open)));
        await sleep(200);
      }
    },

    /**
     * Taps and swipes. Element taps wait up to 10 s for their element. With `alerts`, a system prompt that
     * covers the app is answered first. AXe returns when the gesture ends, not when the screen settles.
     */
    async input(screen: { w: number; h: number }, actions: readonly Action[], alerts: readonly string[] = []) {
      if (alerts.length) await clearPrompts(alerts);
      for (const a of actions) {
        if ('tap' in a) {
          if (isPoint(a.tap)) await tapAt(inPoints(a.tap, screen));
          else await tapTarget(a.tap, alerts);
          continue;
        }
        const [from, to] = [inPoints(a.swipe.from, screen), inPoints(a.swipe.to, screen)];
        await run(bin, [
          'swipe',
          ...['--start-x', from[0], '--start-y', from[1], '--end-x', to[0], '--end-y', to[1]].map((v) =>
            typeof v === 'number' ? String(Math.round(v)) : v,
          ),
          '--duration',
          String(a.swipe.duration / 1000),
          '--udid',
          udid,
        ]);
      }
    },
  };
}
