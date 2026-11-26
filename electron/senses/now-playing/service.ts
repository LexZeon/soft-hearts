// I-089 item 4: the host side of 「知道你正在放什么」. Reads Windows' own now-playing report with one fixed PowerShell program, but only
// while 「和她一起听」' words are on (the caller's `listening()`); the moment it is off the memory is dropped and nothing is read. Memory
// only. electron/senses/listen-together/host.ts owns one of these, so electron/main.ts needs no new lines.

import { execFile } from 'node:child_process';
import { NowPlayingTracker, nowPlayingBlock, nowPlayingForProactive, parseNowPlaying, type NowPlayingKnobs, type NowPlayingSnapshot } from '../../../shared/senses/now-playing';
import { NOW_PLAYING_SCRIPT } from './script';

export type NowPlayingReader = () => Promise<string | null>;

/** The real reader: Windows only, one process per read, 8 seconds at most, never throws. */
export const readSystemNowPlaying: NowPlayingReader = () => new Promise(resolve => {
  if (process.platform !== 'win32') { resolve(null); return; }
  try {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', NOW_PLAYING_SCRIPT],
      { timeout: 8_000, windowsHide: true, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : String(stdout ?? '')));
    child.on('error', () => resolve(null));
  } catch { resolve(null); }
});

export interface NowPlayingServiceDeps {
  /** The switch's words part is on. Off: nothing is read and what was known is forgotten. */
  listening(): boolean;
  read?: NowPlayingReader;
  now?(): number;
  /** How often to look while listening (milliseconds). */
  intervalMs?: number;
  knobs?: Partial<NowPlayingKnobs>;
}

export class NowPlayingService {
  readonly tracker: NowPlayingTracker;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading = false;
  private epoch = 0;
  private readonly now: () => number;
  private readonly read: NowPlayingReader;

  constructor(private readonly deps: NowPlayingServiceDeps) {
    this.tracker = new NowPlayingTracker(deps.knobs);
    this.now = deps.now ?? Date.now;
    this.read = deps.read ?? readSystemNowPlaying;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, Math.max(2_000, this.deps.intervalMs ?? 8_000));
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.epoch++; this.tracker.clear(); }

  /** One look (the timer calls this; tests call it directly). A result that arrives after the switch went off is thrown away. */
  async poll(): Promise<void> {
    if (!this.listening()) { this.tracker.clear(); return; }
    if (this.reading) return;
    this.reading = true;
    const epoch = this.epoch;
    try {
      const output = await this.read();
      if (epoch !== this.epoch || !this.listening()) return;
      this.tracker.observe(output === null ? null : parseNowPlaying(output), this.now());
    } catch { /* No report is the same as nothing playing. */ }
    finally { this.reading = false; }
  }

  /** What is known right now ('null' while off, never read, or the report went stale). */
  snapshot(): NowPlayingSnapshot | null { return this.listening() ? this.tracker.current(this.now()) : null; }
  /** The block for a turn about what is playing ('' when nothing is known). */
  block(): string { return nowPlayingBlock(this.snapshot(), this.now()); }
  /** The paragraph for her pause-point prompt ('' when nothing is known). */
  proactive(): string { return nowPlayingForProactive(this.snapshot(), this.now()); }

  private listening(): boolean { try { return this.deps.listening(); } catch { return false; } }
}
