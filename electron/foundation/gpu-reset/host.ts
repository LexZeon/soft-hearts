// 显卡重置后她自己回来 (docs/claude/2026-11-22-gpu-reset.md): applies plan.ts to the app. Takes the app as a port (no Electron import) so
// tests run it against a fake app; electron/wiring/gpu-reset-wiring.ts passes the real one, before the app is ready.
// It never quits, exits or relaunches the app: a GPU process end is counted, written as one journal row and left to Chromium, which
// starts a new GPU process by itself; the pages' WebGL contexts come back on their own (src/stage/context-recovery.ts).
import { GPU_RESET_KNOBS, GpuResetLog, gpuStartupPlan, type GpuFeatureStatus, type GpuResetRow } from './plan';

/** What this needs of Electron's app (a subset, so a fake app can stand in). */
export interface GpuResetApp {
  readonly commandLine: { appendSwitch(name: string, value?: string): void };
  disableDomainBlockingFor3DAPIs(): void;
  on(event: 'child-process-gone', listener: (event: unknown, details: { type?: unknown; reason?: unknown; exitCode?: unknown }) => void): unknown;
  getGPUFeatureStatus(): GpuFeatureStatus;
}

export interface GpuResetPorts {
  /** One journal row (the wiring adds the type and the character id). */
  record(row: GpuResetRow): void;
  /** The developer log (numbers and closed words only). */
  log?(line: string): void;
  now?(): number;
  setTimer?(run: () => void, ms: number): unknown;
}

/** Call once, before the app is ready. Returns the log (tests read it). */
export function installGpuReset(app: GpuResetApp, ports: GpuResetPorts, knobs = GPU_RESET_KNOBS): GpuResetLog {
  const plan = gpuStartupPlan();
  for (const name of plan.switches) app.commandLine.appendSwitch(name);
  if (plan.disableDomainBlocking) app.disableDomainBlockingFor3DAPIs();
  const log = new GpuResetLog(knobs);
  const now = ports.now ?? Date.now;
  const later = ports.setTimer ?? ((run: () => void, ms: number) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer; });
  const write = (row: GpuResetRow | null) => {
    if (!row) return;
    try { ports.log?.(`GPU process ${row.event}${row.ended ? ` (${row.ended}, exit ${row.exitCode ?? '?'})` : ''}: ${row.recent} in 10 min, ${row.total} this run`); } catch { /* a log line never matters */ }
    try { ports.record(row); } catch { /* the journal never changes what happens to the app */ }
  };
  const checkStatus = () => {
    let status: GpuFeatureStatus | null = null;
    try { status = app.getGPUFeatureStatus(); } catch { status = null; }
    write(log.status(status, now()));
  };
  app.on('child-process-gone', (_event, details) => {
    try { write(log.gone(details, now())); } catch { /* never throws into Electron's event */ }
    if (details?.type === 'GPU') later(checkStatus, knobs.statusCheckMs);
  });
  return log;
}
