/**
 * I-177 batch 2 (docs/claude/2026-11-22-i177-batch2.md): her cloud voice plays on the highest available output of the user's 「听」 list.
 * (plan v2: "听"那一列管她所有的声音).
 *
 * Drama 3 and Bailian (and everything else on the window's shared output: feeding cues, the waiting hum, her short call sounds, the I-150
 * wake tone) go through one AudioContext per window (./audio-output.ts). `AudioContext.setSinkId` (Chromium 110+, Electron 45 is Chromium
 * 140) moves that whole context to another output device, so routing it moves all of them together, the wake tone included.
 *
 * `OutputSink.align(context)` asks `choose()` for the device wanted now (null or '' = the system default: an empty list, or none of its
 * entries plugged in), compares with the context's current sink and switches only when they differ. A switch that fails or takes longer
 * than SINK_SWITCH_TIMEOUT_MS never holds her voice: it falls back to the system default (a device that disappeared ends up there too, on
 * the next check). Aligns on one context run one after another. The free system voice (speechSynthesis) cannot be routed and keeps the
 * system output; the settings page says so.
 */

/** What this file needs of an AudioContext (TypeScript's DOM types do not have AudioContext.setSinkId yet). */
export interface SinkContext { setSinkId?(sinkId: string): Promise<void>; readonly sinkId?: unknown }
export type SinkResult = 'same' | 'moved' | 'unsupported';
export interface OutputSinkOptions {
  /** The output device id wanted now; null or '' = the system default. Rejecting counts as the default. */
  choose(): Promise<string | null>;
  timeoutMs?: number;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** Longest a device switch may take before it is given up (and the system default used). */
export const SINK_SWITCH_TIMEOUT_MS = 3000;

/** This window's AudioContext can be routed to a chosen output (Electron 45: yes). */
export function sinkSupported(context: unknown = (globalThis as { AudioContext?: { prototype?: unknown } }).AudioContext?.prototype): boolean {
  return !!context && typeof (context as SinkContext).setSinkId === 'function';
}

const currentSink = (context: SinkContext): string => typeof context.sinkId === 'string' ? context.sinkId : '';

export class OutputSink {
  private chain: Promise<unknown> = Promise.resolve();
  /** Switches made and fallbacks to the default, for tests and diagnostics (no device names). */
  readonly stats = { moved: 0, fallbacks: 0 };
  constructor(private readonly options: OutputSinkOptions) {}

  /** Put `context` on the wanted output. Never rejects. */
  align(context: AudioContext): Promise<SinkResult> {
    const run = this.chain.then(() => this.once(context as unknown as SinkContext), () => this.once(context as unknown as SinkContext));
    this.chain = run.catch(() => undefined);
    return run.catch(() => 'same' as const);
  }

  private async once(context: SinkContext): Promise<SinkResult> {
    if (!sinkSupported(context)) return 'unsupported';
    let wanted = '';
    try { wanted = (await this.options.choose()) ?? ''; } catch { wanted = ''; }
    const before = currentSink(context);
    if (wanted === before) return 'same';
    if (await this.switch(context, wanted)) { this.stats.moved++; return 'moved'; }
    // The chosen device refused or hung: the system default, never silence on a device that is gone.
    this.stats.fallbacks++;
    if (wanted !== '' && currentSink(context) !== '' && await this.switch(context, '')) { this.stats.moved++; return 'moved'; }
    return currentSink(context) === before ? 'same' : 'moved';
  }

  private switch(context: SinkContext, id: string): Promise<boolean> {
    const timers = this.options.timers ?? { set: (callback: () => void, ms: number) => setTimeout(callback, ms), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    return new Promise<boolean>(resolve => {
      let done = false;
      const finish = (ok: boolean) => { if (done) return; done = true; timers.clear(timer); resolve(ok); };
      const timer = timers.set(() => finish(false), this.options.timeoutMs ?? SINK_SWITCH_TIMEOUT_MS);
      try { Promise.resolve(context.setSinkId!(id)).then(() => finish(true), () => finish(false)); } catch { finish(false); }
    });
  }
}
