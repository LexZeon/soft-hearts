// 显卡有没有用上 (2026-11-24, docs/claude/2026-11-24-stage-smooth.md): applies plan.ts to the app. Takes the app as a port (no Electron import) so
// tests run it against a fake app; electron/wiring/gpu-choice-wiring.ts passes the real one, before the app is ready. It never quits, relaunches
// or changes a setting of Windows: one Chromium switch before ready, and one journal row a few seconds after the app is up.
import { GPU_CHOICE_SWITCH, gpuChoicePlan, gpuStartLine, gpuStartRow, type GpuProbe } from './plan';
import type { GpuDeviceFacts, GpuStartRow } from '../../../shared/foundation/gpu-kind';

/** What this needs of Electron's app (a subset, so a fake app can stand in). */
export interface GpuChoiceApp {
  readonly commandLine: { appendSwitch(name: string, value?: string): void; hasSwitch(name: string): boolean };
  whenReady(): Promise<unknown>;
  getGPUInfo(kind: 'basic'): Promise<unknown>;
}
export interface GpuChoicePorts {
  /** A throw-away WebGL context's renderer string (the wiring makes a hidden page for it); null when it cannot be read. */
  probe(): Promise<GpuProbe | null>;
  /** One journal row (the wiring adds the type; the character is not known at start). */
  record(row: GpuStartRow): void;
  log?(line: string): void;
  setTimer?(run: () => void, ms: number): unknown;
}
/** After ready, the row waits this long so the launch is not slowed by it (ms). */
export const GPU_START_DELAY_MS = 4_000;

/** Call once, before the app is ready. Returns the switches it appended (tests read them). */
export function installGpuChoice(app: GpuChoiceApp, ports: GpuChoicePorts): readonly string[] {
  const plan = gpuChoicePlan(name => app.commandLine.hasSwitch(name));
  for (const name of plan.switches) app.commandLine.appendSwitch(name);
  const later = ports.setTimer ?? ((run: () => void, ms: number) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer; });
  void app.whenReady().then(() => {
    later(() => {
      void (async () => {
        let probe: GpuProbe | null = null, devices: readonly GpuDeviceFacts[] | null = null;
        try { probe = await ports.probe(); } catch { probe = null; }
        try { devices = ((await app.getGPUInfo('basic')) as { gpuDevice?: readonly GpuDeviceFacts[] } | null | undefined)?.gpuDevice ?? null; } catch { devices = null; }
        const row = gpuStartRow(probe, devices, app.commandLine.hasSwitch(GPU_CHOICE_SWITCH));
        try { ports.log?.(gpuStartLine(row)); } catch { /* a log line never matters */ }
        try { ports.record(row); } catch { /* the journal never changes what happens to the app */ }
      })();
    }, GPU_START_DELAY_MS);
  }, () => undefined);
  return plan.switches;
}
