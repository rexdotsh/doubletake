import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lockDevice } from '../src/store.ts';

test("a killed bench's device lock is taken over; a live one is not", async () => {
  const home = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'dt-store-'));
  const before = process.env.DOUBLETAKE_HOME;
  process.env.DOUBLETAKE_HOME = home;
  try {
    await mkdir(join(home, 'locks'));
    await writeFile(join(home, 'locks', 'sim.pid'), '999999999');
    const release = await lockDevice('sim');
    await writeFile(join(home, 'locks', 'other.pid'), String(process.ppid));
    const refused = await lockDevice('other').then(
      () => '',
      (error: unknown) => String(error),
    );
    expect(refused).toMatch(/in use by pid/);
    await release();

    // Two benches that both find the same dead holder: exactly one gets the device.
    await writeFile(join(home, 'locks', 'race.pid'), '999999999');
    const both = await Promise.allSettled([lockDevice('race'), lockDevice('race')]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  } finally {
    if (before === undefined) delete process.env.DOUBLETAKE_HOME;
    else process.env.DOUBLETAKE_HOME = before;
    await rm(home, { recursive: true, force: true });
  }
});
