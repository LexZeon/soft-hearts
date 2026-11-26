// 保存她念出来的声音（用来比对）: the host of the dev-only tool. It owns the switch and the days (a small settings.json beside the audio,
// not part of the app's settings, so the stable build's settings never mention it), the hourly sweep of old days, 清空 (which asks first),
// 打开文件夹, and the one view the control window and the channel read. On a stable or packaged build `available` is false: every
// operation answers "not here", nothing is read or written, and a stale settings file saying "on" is ignored.
import { appendFile, mkdir } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { VOICE_KEEP_DEFAULT_DAYS, VOICE_KEEP_EVENTS_FILE, VOICE_KEEP_SETTINGS_FILE, VOICE_KEEP_SIZE_CAP_BYTES, VOICE_KEEP_SWEEP_MS, clampKeepDays } from './knobs';
import type { VoiceKeepView } from '../../../shared/voice/voice-keep';
import { VoiceKeepRecorder } from './recorder';
import { VoiceKeepStore } from './store';

export interface VoiceKeepHostPorts {
  profileDirectory: string;
  available(): boolean;
  now(): number;
  character(): { id: string; name: string } | null;
  /** 「清空」 asks first (a dialog of the app, never the window's own say-so); true: go ahead. */
  confirmClear(count: { sentences: number; bytes: number }): Promise<boolean>;
  openFolder(folder: string): Promise<unknown> | unknown;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface Saved { on: boolean; days: number }
const NOT_HERE: VoiceKeepView = { available: false, on: false, days: VOICE_KEEP_DEFAULT_DAYS, sentences: 0, bytes: 0, capped: false, capBytes: VOICE_KEEP_SIZE_CAP_BYTES };

export class VoiceKeepHost {
  readonly store: VoiceKeepStore;
  readonly recorder: VoiceKeepRecorder;
  private saved: Saved = { on: false, days: VOICE_KEEP_DEFAULT_DAYS };
  private timer: unknown = null;
  private measuredAt: { bytes: number; sentences: number } = { bytes: 0, sentences: 0 };

  constructor(private readonly ports: VoiceKeepHostPorts) {
    this.store = new VoiceKeepStore(ports.profileDirectory);
    this.recorder = new VoiceKeepRecorder({ available: () => ports.available(), on: () => this.saved.on, character: () => ports.character(), now: () => ports.now(),
      store: this.store, event: row => this.event(row) });
    if (ports.available()) this.load();
  }

  get available(): boolean { return this.ports.available(); }
  private get settingsFile(): string { return path.join(this.store.root, VOICE_KEEP_SETTINGS_FILE); }
  private load(): void {
    try {
      const value = JSON.parse(readFileSync(this.settingsFile, 'utf8')) as Record<string, unknown>;
      this.saved = { on: value.on === true, days: clampKeepDays(value.days) };
    } catch { /* no settings yet: off, 7 days */ }
  }
  private save(): void {
    try { mkdirSync(this.store.root, { recursive: true }); writeFileSync(this.settingsFile, JSON.stringify(this.saved), 'utf8'); } catch { /* the choice still holds for this run */ }
  }
  private event(row: Record<string, string | number | boolean>): void {
    if (!this.ports.available()) return;
    void mkdir(this.store.root, { recursive: true }).then(() => appendFile(path.join(this.store.root, VOICE_KEEP_EVENTS_FILE),
      `${JSON.stringify({ time: new Date(this.ports.now()).toISOString(), ...row })}\n`, 'utf8')).catch(() => { /* a note, never a failure */ });
  }

  /** Start: look at the disk once, remove old days, and go on doing that while the app runs. */
  async start(): Promise<void> {
    if (!this.available) return;
    await this.sweep();
    const set = this.ports.setTimer ?? ((run: () => void, ms: number) => { const handle = setInterval(run, ms); handle.unref?.(); return handle; });
    this.timer ??= set(() => { void this.sweep(); }, VOICE_KEEP_SWEEP_MS);
  }
  stop(): void {
    if (this.timer === null) return;
    (this.ports.clearTimer ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = null;
  }
  /** Old days go (also when the user shortens the days); then the disk is measured again. */
  async sweep(): Promise<number> {
    if (!this.available) return 0;
    const removed = await this.store.sweep(this.ports.now(), this.saved.days);
    if (removed) this.event({ kind: 'expired', days: removed, keepDays: this.saved.days });
    await this.measure();
    return removed;
  }
  private async measure(): Promise<void> {
    this.measuredAt = await this.store.measure();
    this.recorder.measured(this.measuredAt.bytes);
  }

  view(): VoiceKeepView {
    if (!this.available) return { ...NOT_HERE };
    return { available: true, on: this.saved.on, days: this.saved.days, sentences: this.measuredAt.sentences, bytes: Math.max(this.measuredAt.bytes, this.recorder.bytes),
      capped: this.recorder.isCapped, capBytes: VOICE_KEEP_SIZE_CAP_BYTES };
  }

  /** Turning it on is the caller's job to ask for (the window's own click is the user's; the channel needs words and a dialog first). */
  async setOn(on: boolean): Promise<VoiceKeepView> {
    if (!this.available) return this.view();
    if (this.saved.on !== on) { this.saved = { ...this.saved, on }; this.save(); this.event({ kind: on ? 'on' : 'off', keepDays: this.saved.days }); }
    if (on) await this.measure();
    return this.view();
  }
  async setDays(days: unknown): Promise<VoiceKeepView> {
    if (!this.available) return this.view();
    const next = clampKeepDays(days);
    if (next !== this.saved.days) { this.saved = { ...this.saved, days: next }; this.save(); await this.sweep(); }
    return this.view();
  }
  /** 清空: asks first; nothing is removed unless the user says yes in the dialog. Returns the view and whether it was done. */
  async clear(): Promise<{ view: VoiceKeepView; cleared: boolean }> {
    if (!this.available) return { view: this.view(), cleared: false };
    await this.measure();
    if (!await this.ports.confirmClear({ sentences: this.measuredAt.sentences, bytes: this.measuredAt.bytes })) return { view: this.view(), cleared: false };
    const days = await this.store.clear();
    this.event({ kind: 'cleared', days });
    await this.measure();
    return { view: this.view(), cleared: true };
  }
  async openFolder(): Promise<boolean> {
    if (!this.available) return false;
    try { mkdirSync(this.store.root, { recursive: true }); await this.ports.openFolder(this.store.root); return true; } catch { return false; }
  }

  /** The control window's one call (validated here; the window cannot name a path or a size). */
  async handle(raw: unknown): Promise<VoiceKeepView> {
    const request = raw as { op?: unknown; days?: unknown } | null;
    switch (request?.op) {
      case 'on': return this.setOn(true);
      case 'off': return this.setOn(false);
      case 'days': return this.setDays(request.days);
      case 'clear': return (await this.clear()).view;
      case 'open': await this.openFolder(); return this.view();
      default: return this.view();
    }
  }
}
