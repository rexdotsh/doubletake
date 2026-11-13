import { resolve } from 'node:path';
import type { Step } from './bench.ts';
import { ms } from './bench.ts';
import type { Action, Device, Launched, LogTap } from './device.ts';
import type { SdkEvent } from './events.ts';
import { maestro } from './maestro.ts';
import { run, sleep } from './sh.ts';

export type FlowState = {
  device: Device;
  appId: string;
  tap: LogTap;
  /** Folder the bench file is in: maestro paths resolve from it. */
  dir: string;
  /** Device-clock time from which a `wait: mark:` accepts marks: the last launch or action. */
  since: number;
  /** Marks a wait already took, so a second wait for the same name needs a new one. */
  consumed: Set<SdkEvent>;
  offset: number;
  launched?: Launched;
  /** The bench's `alerts`: system prompt buttons input taps first. */
  alerts?: readonly string[];
};

export async function launch(state: FlowState): Promise<Launched> {
  await state.device.terminate(state.appId);
  const launched = await state.device.launch(state.appId);
  state.launched = launched;
  state.since = launched.t0 + state.offset;
  return launched;
}

const SCROLL: Record<'down' | 'up', Action> = {
  down: { swipe: { from: [0.5, 0.75], to: [0.5, 0.25], duration: 300 } },
  up: { swipe: { from: [0.5, 0.25], to: [0.5, 0.75], duration: 300 } },
};

function actionOf(step: Step): Action[] | null {
  if (typeof step === 'string') return null;
  if ('tap' in step) return [{ tap: step.tap }];
  if ('swipe' in step)
    return [{ swipe: { ...step.swipe, duration: step.swipe.duration ? ms(step.swipe.duration) : 300 } }];
  if ('scroll' in step) return Array.from({ length: step.times ?? 1 }, () => SCROLL[step.scroll]);
  return null;
}

/** Runs steps in order; consecutive taps, swipes and scrolls go to the device as one batch. */
export async function runSteps(steps: readonly Step[], state: FlowState): Promise<void> {
  let batch: Action[] = [];
  const act = async (action: () => Promise<unknown>) => {
    state.since = Date.now() + state.offset;
    await action();
  };
  const flush = async () => {
    if (batch.length) await act(() => state.device.input(state.appId, batch, state.alerts));
    batch = [];
  };
  for (const step of steps) {
    const actions = actionOf(step);
    if (actions) {
      batch.push(...actions);
      continue;
    }
    await flush();
    if (step === 'launch') await launch(state);
    else if (step === 'terminate') await state.device.terminate(state.appId);
    else if ('open' in step) await act(() => state.device.openUrl(step.open));
    else if ('wait' in step) {
      const name = step.wait.slice('mark:'.length);
      const pid = state.launched?.pid;
      const match = (e: SdkEvent) =>
        e.kind === 'mark' &&
        e.name === name &&
        !state.consumed.has(e) &&
        (e.pid === undefined || pid === undefined || e.pid === pid);
      state.consumed.add(await state.tap.waitFor(match, state.since, step.timeout ? ms(step.timeout) : 30_000));
    } else if ('sleep' in step) await sleep(ms(step.sleep));
    else if ('maestro' in step) await act(() => maestro(state.device.id, resolve(state.dir, step.maestro), step.env));
    else if ('shell' in step) await act(() => run('sh', ['-c', step.shell], { cwd: state.dir }));
    else if ('repeat' in step) for (let i = 0; i < step.times; i++) await runSteps(step.repeat, state);
  }
  await flush();
}
