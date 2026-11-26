// 显卡重置后她自己回来 (docs/claude/2026-11-22-gpu-reset.md): the GPU process watch, wired from electron/wiring/health-wiring.ts wireHealth
// (module top level of electron/main.ts, before the app is ready, which the Chromium switch and disableDomainBlockingFor3DAPIs need).
// No module-level side effects: nothing here runs until wireGpuReset is called.
import { app } from 'electron';
import type { JournalInput } from '../../shared/memory';
import { installGpuReset } from '../foundation/gpu-reset/host';

export interface GpuResetNeeds {
  readonly appJournal: { record(input: JournalInput): unknown };
  journalCharacterId(): string | null;
}

/** Once, before ready: lifts Chromium's GPU crash limit and the WebGL domain block, and journals each GPU process end. */
export function wireGpuReset(needs: GpuResetNeeds): void {
  installGpuReset(app, {
    record: row => { needs.appJournal.record({ type: 'gpu-reset', characterId: needs.journalCharacterId(), ...row }); },
    log: line => console.warn(line),
  });
}
