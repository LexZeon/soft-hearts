// 显卡重置后她自己回来 (2026-11-22, docs/claude/2026-11-22-gpu-reset.md): what the host does when Chromium's GPU process goes away.
// Pure: no Electron import. electron/foundation/gpu-reset/host.ts applies it to the app; electron/wiring/gpu-reset-wiring.ts wires it.
//
// Measured on Electron 45.0.0 / Chromium 156 (the repro in the record): with Chromium's defaults the 1st GPU crash is survived and WebGL
// comes back; from the 2nd crash on, WebGL is blocked for the page ("domain blocking": the context never comes back, she stays invisible);
// at the 3rd Chromium falls back to software compositing (WebGL off); at the 6th it gives up: "GPU process isn't usable. Goodbye." is a
// FATAL in the browser process and the whole app ends. With `disable-gpu-process-crash-limit` and app.disableDomainBlockingFor3DAPIs() the
// same build survived 8 crashes in a row and every WebGL context came back each time. Either alone is not enough (also measured).

/** The Chromium switch that lifts the GPU process crash limit (exists in Chromium 156; verified by the repro, not assumed). */
export const GPU_CRASH_LIMIT_SWITCH = 'disable-gpu-process-crash-limit';

export interface GpuStartupPlan {
  /** Chromium switches to append before the app is ready. */
  readonly switches: readonly string[];
  /** Call app.disableDomainBlockingFor3DAPIs() before ready (otherwise WebGL is blocked for the page after a second GPU crash). */
  readonly disableDomainBlocking: boolean;
}

/** Before ready: what keeps a GPU process crash from ending the app or leaving her invisible. Always the same for now. */
export function gpuStartupPlan(): GpuStartupPlan {
  return { switches: [GPU_CRASH_LIMIT_SWITCH], disableDomainBlocking: true };
}

import { GPU_PROCESS_ENDS, type GpuProcessEnd } from '../../../shared/foundation/gpu-reset';
export { GPU_PROCESS_ENDS, type GpuProcessEnd };

/** One journal row's content (numbers and closed words only; the wiring adds the type and the character). */
export type GpuResetRow =
  /** The GPU process went away (Chromium starts a new one by itself). */
  | { event: 'gone'; ended: GpuProcessEnd; exitCode: number | null; recent: number; total: number }
  /** WebGL is off for the rest of this run: Chromium fell back to software compositing (only an init failure does that once the limit is lifted). */
  | { event: 'software'; ended: null; exitCode: null; recent: number; total: number };

export const GPU_RESET_KNOBS = Object.freeze({
  /** "Recent" means within this window. */
  recentMs: 10 * 60_000,
  /** Every crash is written while there were at most this many in the window; after that every 20th (a crash storm never floods the journal). */
  journalEvery: 20,
  /** After a crash, the feature status is read again after this long (Chromium's fallback decision is made while the new process starts). */
  statusCheckMs: 1_500,
});

/** The part of app.getGPUFeatureStatus() read here. */
export interface GpuFeatureStatus { readonly webgl?: unknown }

/** WebGL works when Chromium's feature status for it starts with "enabled" (enabled, enabled_readback, enabled_force, ...). */
export function webglWorks(status: GpuFeatureStatus | null | undefined): boolean | null {
  const value = status?.webgl;
  return typeof value === 'string' ? value.startsWith('enabled') : null;
}

function endOf(reason: unknown): GpuProcessEnd {
  return typeof reason === 'string' && (GPU_PROCESS_ENDS as readonly string[]).includes(reason) ? reason as GpuProcessEnd : 'unknown';
}

/** Counts GPU process ends and says which ones become a journal row. Never decides to end or relaunch the app. */
export class GpuResetLog {
  private times: number[] = [];
  private totalGone = 0;
  private softwareNoted = false;

  constructor(private readonly knobs = GPU_RESET_KNOBS) {}

  get total(): number { return this.totalGone; }

  /** Ends in the last `recentMs`, as of `now`. */
  recent(now: number): number {
    this.times = this.times.filter(at => now - at < this.knobs.recentMs && at <= now);
    return this.times.length;
  }

  /** A `child-process-gone`: the row to write, or null (not the GPU process, or a storm row that is skipped). */
  gone(details: { type?: unknown; reason?: unknown; exitCode?: unknown } | null | undefined, now: number): GpuResetRow | null {
    if (!details || details.type !== 'GPU') return null;
    this.times.push(now);
    this.totalGone++;
    const recent = this.recent(now);
    if (recent > this.knobs.journalEvery && recent % this.knobs.journalEvery !== 0) return null;
    const exitCode = typeof details.exitCode === 'number' && Number.isInteger(details.exitCode) ? Math.max(-2_147_483_648, Math.min(4_294_967_295, details.exitCode)) : null;
    return { event: 'gone', ended: endOf(details.reason), exitCode, recent, total: this.totalGone };
  }

  /** The feature status after a crash: one 'software' row the first time WebGL is found off after a GPU process end, else null. */
  status(status: GpuFeatureStatus | null | undefined, now: number): GpuResetRow | null {
    if (this.softwareNoted || this.totalGone === 0 || webglWorks(status) !== false) return null;
    this.softwareNoted = true;
    return { event: 'software', ended: null, exitCode: null, recent: this.recent(now), total: this.totalGone };
  }
}
