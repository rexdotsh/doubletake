import { bridgeProbe } from './bridge.ts';
import { cdpProbe } from './cdp.ts';
import type { Device } from './device.ts';
import type { ProbeConfig, ProbeSession } from './probe.ts';

export function openProbe(config: ProbeConfig, device: Device, appId: string): ProbeSession {
  return 'cdp' in config ? cdpProbe(config.cdp, appId, device.name) : bridgeProbe(config.bridge, device);
}
