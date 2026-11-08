import type { AppSettings } from "../../shared/contracts";
import { defaultAudioTimers, type AudioOutputTimers } from "./audio-output";
import { speakableText } from "../../shared/speakable-text";

/** The user's system voice settings plus this reply's frozen mood pitch (absent = engine default). */
export type SystemVoiceConfig = AppSettings["voice"] & { pitch?: number };

/** Facts about one system utterance, for dev diagnostics. Never carries the text. */
export type SystemSpeechEvent =
  | { type: "queued" | "start" | "first-boundary" | "end" | "quick-end"; at: number }
  | { type: "stall"; at: number; reason: "not-speaking" | "no-progress" }
  | { type: "resume"; at: number }
  | { type: "error"; at: number; code: string }
  | { type: "cancel"; at: number; reason: "interrupted" }
  /** B06 feed pause of an utterance this adapter owns, and its end. */
  | { type: "feed-pause" | "feed-resume"; at: number }
  /** pause() did not hold (or resume() did not continue): cancelled, to be re-spoken from the last word boundary. */
  | { type: "pause-fallback"; at: number; reason: "still-speaking" | "resume-stuck" };
export interface SpeechOutputHooks {
  /** Lip-sync only: false when the engine stops making progress, true when it resumes. */
  onMouth?(active: boolean): void;
  onEvent?(event: SystemSpeechEvent): void;
  timers?: AudioOutputTimers;
  now?(): number;
}

/** Chromium can drop an utterance spoken in the same task as cancel(); give the engine a moment. */
export const CANCEL_SETTLE_MS = 80;
/** An utterance that ends this soon after starting, with real text, very likely made no sound. */
export const QUICK_END_MS = 300;
/** With boundary events seen before, this long without one while "speaking" closes the mouth. */
export const NO_PROGRESS_MS = 2500;
/** After speechSynthesis.pause(), the engine must have acknowledged it (and gone quiet) within this time. */
export const PAUSE_CONFIRM_MS = 350;
/** After speechSynthesis.resume(), an engine that still reports `paused` this long later is stuck. */
export const RESUME_CONFIRM_MS = 600;
/** Boundary events this soon after pause() may have been dispatched before it took effect. */
const PAUSE_GRACE_MS = 150;
const RESUME_POLL_MS = 50;
const WATCH_MS = 400;
const FAILED_TO_PLAY = "系统语音未能播放，请检查系统语音设置后重试。";

/** One requested utterance; after a pause fallback its remainder is re-spoken as a new engine utterance. */
interface Active {
  text: string;
  /** Start (in `text`) of the part currently handed to the engine. */
  offset: number;
  config: SystemVoiceConfig;
  engine: SpeechSynthesisUtterance | null;
  started: boolean; startedAt: number; lastProgress: number;
  /** The part currently with the engine has started (the first part: same as `started`). */
  partStarted: boolean;
  stalls: number; mouthOpen: boolean; boundaries: number;
  /** Start (in `text`) of the word the engine reached last; null when it never reported one. */
  boundary: number | null;
  respoken: boolean;
  /** waiting: not with the engine (paused before speaking, or cancelled by the fallback). */
  pause: "none" | "confirming" | "native" | "waiting" | "resuming";
  pauseAt: number; pauseAck: boolean; resumeAck: boolean; progressAfterPause: boolean;
  resolve(): void; reject(error: Error): void;
}

/**
 * Web Speech output (R02). Within one reply, segments are spoken back to back
 * without cancel(): cancel() is issued only to interrupt an utterance this
 * adapter still owns. Lip-sync follows the engine's own progress signals as far
 * as the API allows (start, word boundaries, `speechSynthesis.speaking`).
 *
 * B06 feed pause: pause() holds the current utterance with
 * `speechSynthesis.pause()`. That call is unreliable on some platforms, so an
 * engine that has not acknowledged it (or keeps reporting word progress) after
 * PAUSE_CONFIRM_MS is cancelled instead, and resume() re-speaks the rest from
 * the last word boundary (the whole utterance when the engine never reported
 * one). Anything spoken while paused waits for resume().
 */
export class SpeechOutput {
  private active: Active | null = null;
  private deferred: unknown = null;
  private watch: unknown = null;
  private pauseTimer: unknown = null;
  private paused = false;
  private lastCancelAt = -Infinity;
  /** Learned per engine: once any boundary event fires, boundaries count as progress. */
  private boundarySupported = false;
  constructor(private onSpeaking: (active: boolean) => void, private readonly hooks: SpeechOutputHooks = {}) {}
  voices(): SpeechSynthesisVoice[] {
    return speechSynthesis.getVoices();
  }
  speak(text: string, config: SystemVoiceConfig): Promise<void> {
    // Stage directions in brackets are shown, never read (shared/speakable-text.ts).
    text = speakableText(text);
    const interrupted = this.stop();
    if (!config.enabled || !text.trim()) return Promise.resolve();
    let resolve!: () => void, reject!: (error: Error) => void;
    const finished = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    void finished.catch(() => {});
    const active: Active = {
      text: text.slice(0, 6000), offset: 0, config: { ...config }, engine: null,
      started: false, startedAt: 0, lastProgress: 0, partStarted: false, stalls: 0, mouthOpen: false, boundaries: 0, boundary: null, respoken: false,
      pause: "none", pauseAt: 0, pauseAck: false, resumeAck: false, progressAfterPause: false, resolve, reject,
    };
    this.active = active;
    this.hooks.onEvent?.({ type: "queued", at: this.now() });
    if (this.paused) active.pause = "waiting";
    else if (interrupted) this.handLater(active, CANCEL_SETTLE_MS);
    else this.hand(active);
    return finished;
  }
  /** Returns true when an owned utterance was actually interrupted with cancel(). */
  stop(): boolean {
    const active = this.active, owned = active !== null;
    this.active = null;
    this.disarm();
    active?.resolve();
    let interrupted = false;
    const engine = this.engine();
    // Cancel only a real interruption: never between back-to-back segments of one reply.
    if (owned || engine?.speaking === true || engine?.pending === true) {
      interrupted = true;
      this.hooks.onEvent?.({ type: "cancel", at: this.now(), reason: "interrupted" });
      this.cancelEngine();
    }
    this.onSpeaking(false);
    return interrupted;
  }
  /**
   * B06: hold speech while a snack is at her mouth. Idempotent; stop() still
   * cancels as usual. `release`: do not keep the engine paused (a feeding cue
   * needs it): cancel now and re-speak from the last word boundary on resume.
   */
  pause(release = false): void {
    if (this.paused) return;
    this.paused = true;
    const active = this.active;
    if (!active) return;
    const at = this.now();
    this.hooks.onEvent?.({ type: "feed-pause", at });
    this.clearWatch(); this.clearPauseTimer();
    if (this.deferred !== null || !active.engine || active.pause === "waiting") { this.clearDeferred(); active.pause = "waiting"; return; }
    if (!active.partStarted) {
      // Queued in the engine but not audible yet: take it back and speak this part again on resume.
      active.engine = null; active.pause = "waiting";
      this.cancelEngine();
      return;
    }
    if (release) { this.yieldEngine(active); return; }
    this.mouth(active, false);
    active.pause = "confirming"; active.pauseAt = at; active.pauseAck = false; active.progressAfterPause = false;
    try { speechSynthesis.pause(); } catch { this.fallback(active, "still-speaking"); return; }
    this.pauseTimer = this.timers.set(() => { this.pauseTimer = null; this.confirmPause(active); }, PAUSE_CONFIRM_MS);
  }
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const active = this.active;
    if (!active) return;
    this.hooks.onEvent?.({ type: "feed-resume", at: this.now() });
    this.clearPauseTimer();
    if (active.pause === "confirming" || active.pause === "native") {
      active.pause = "resuming"; active.resumeAck = false; active.pauseAt = this.now();
      try { speechSynthesis.resume(); } catch { this.fallback(active, "resume-stuck"); this.continueWaiting(active); return; }
      this.pauseTimer = this.timers.set(() => this.pollResume(active), RESUME_POLL_MS);
    } else if (active.pause === "waiting") this.continueWaiting(active);
  }
  dispose(): void { this.stop(); }

  /** Hand the (rest of the) utterance to the engine. */
  private hand(active: Active): void {
    if (this.active !== active) return;
    if (this.paused) { active.pause = "waiting"; return; }
    active.pause = "none"; active.partStarted = false;
    const offset = active.offset, rest = active.text.slice(offset);
    // A fallback right at the end leaves nothing to say: the utterance is complete.
    if (offset > 0 && !rest.trim()) { this.complete(active); return; }
    let utterance: SpeechSynthesisUtterance;
    try {
      utterance = new SpeechSynthesisUtterance(rest);
      utterance.voice =
        this.voices().find((v) => v.voiceURI === active.config.voiceURI) ??
        this.voices().find((v) => v.lang.startsWith("zh")) ??
        null;
      utterance.lang = utterance.voice?.lang ?? "zh-CN";
      utterance.rate = active.config.rate;
      if (active.config.pitch !== undefined && Number.isFinite(active.config.pitch)) utterance.pitch = active.config.pitch;
      utterance.volume = active.config.volume;
    } catch { this.complete(active, new Error(FAILED_TO_PLAY)); return; }
    utterance.onstart = () => { if (active.engine === utterance) this.engineStart(active); };
    utterance.onboundary = (event?: SpeechSynthesisEvent) => { if (active.engine === utterance) this.engineBoundary(active, offset, event); };
    utterance.onpause = () => { if (active.engine === utterance) active.pauseAck = true; };
    utterance.onresume = () => { if (active.engine === utterance) { active.resumeAck = true; if (active.pause === "resuming") this.resumed(active); } };
    utterance.onend = () => {
      if (active.engine !== utterance) return;
      // Ended while confirmed paused: interrupted from outside (never a natural end). Continue later.
      if (this.paused && active.pause === "native") { this.yieldEngine(active, false); return; }
      this.engineEnd(active);
    };
    utterance.onerror = (event?: SpeechSynthesisErrorEvent) => {
      if (active.engine !== utterance) return;
      if (this.paused && active.pause === "native") { this.yieldEngine(active, false); return; }
      this.hooks.onEvent?.({ type: "error", at: this.now(), code: String(event?.error ?? "unknown").slice(0, 40) });
      this.complete(active, new Error("系统语音播放失败，请检查系统语音设置后重试。"));
    };
    active.engine = utterance;
    // An engine left paused (by us or another window) would hold this utterance silently.
    try { if (this.engine()?.paused === true) speechSynthesis.resume(); } catch { /* Best effort. */ }
    try { speechSynthesis.speak(utterance); } catch { this.complete(active, new Error(FAILED_TO_PLAY)); }
  }
  private handLater(active: Active, ms: number): void {
    this.clearDeferred();
    if (ms <= 0) { this.hand(active); return; }
    this.deferred = this.timers.set(() => {
      this.deferred = null;
      if (this.active !== active) return;
      if (this.paused) active.pause = "waiting"; else this.hand(active);
    }, ms);
  }
  /** Speak a waiting utterance, keeping Chromium's settle gap after our last cancel(). */
  private continueWaiting(active: Active): void {
    this.handLater(active, Math.max(0, CANCEL_SETTLE_MS - (this.now() - this.lastCancelAt)));
  }
  private engineStart(active: Active): void {
    const at = this.now();
    active.lastProgress = at; active.stalls = 0; active.partStarted = true;
    if (!active.started) {
      active.started = true; active.startedAt = at; active.mouthOpen = true;
      this.hooks.onEvent?.({ type: "start", at });
      this.onSpeaking(true);
    } else this.mouth(active, true); // the re-spoken rest after a pause fallback: lip-sync only
    this.arm(active);
  }
  private engineBoundary(active: Active, offset: number, event?: SpeechSynthesisEvent): void {
    const at = this.now();
    this.boundarySupported = true; active.lastProgress = at;
    const index = offset + Number(event?.charIndex);
    if (Number.isSafeInteger(index) && index >= offset && index < active.text.length) active.boundary = Math.max(active.boundary ?? 0, index);
    if (++active.boundaries === 1) this.hooks.onEvent?.({ type: "first-boundary", at });
    if (active.pause === "confirming") { if (at - active.pauseAt > PAUSE_GRACE_MS) active.progressAfterPause = true; return; }
    // Word progress while the engine claims to be paused: the pause did not hold.
    if (active.pause === "native") { this.fallback(active, "still-speaking"); return; }
    if (active.pause === "resuming") { active.resumeAck = true; this.resumed(active); return; }
    if (this.paused || active.pause !== "none") return;
    if (active.started && !active.mouthOpen) { this.mouth(active, true); this.hooks.onEvent?.({ type: "resume", at }); }
  }
  private engineEnd(active: Active): void {
    const at = this.now();
    if (active.started && !active.respoken && at - active.startedAt < QUICK_END_MS && active.text.trim().length >= 4)
      this.hooks.onEvent?.({ type: "quick-end", at });
    this.hooks.onEvent?.({ type: "end", at });
    this.complete(active, active.started ? undefined : new Error("系统语音未开始播放，请检查系统语音设置后重试。"));
  }
  private complete(active: Active, error?: Error): void {
    active.engine = null; // late engine callbacks of a settled utterance change nothing
    if (this.active !== active) { active.resolve(); return; }
    this.active = null;
    this.disarm();
    if (error) active.reject(error); else active.resolve();
    this.onSpeaking(false);
  }
  private confirmPause(active: Active): void {
    if (this.active !== active || !this.paused || active.pause !== "confirming") return;
    const engine = this.engine();
    // "Still speaking": word progress after the pause, or the engine never acknowledged it.
    if (!active.progressAfterPause && (active.pauseAck || engine?.paused === true)) { active.pause = "native"; return; }
    this.fallback(active, "still-speaking");
  }
  private pollResume(active: Active): void {
    this.pauseTimer = null;
    if (this.active !== active || this.paused || active.pause !== "resuming") return;
    const engine = this.engine(), waited = this.now() - active.pauseAt;
    const paused = typeof engine?.paused === "boolean" ? engine.paused : waited < RESUME_CONFIRM_MS;
    if (active.resumeAck || !paused) { this.resumed(active); return; }
    if (waited >= RESUME_CONFIRM_MS) { this.fallback(active, "resume-stuck"); this.continueWaiting(active); return; }
    this.pauseTimer = this.timers.set(() => this.pollResume(active), RESUME_POLL_MS);
  }
  private resumed(active: Active): void {
    this.clearPauseTimer();
    active.pause = "none"; active.lastProgress = this.now(); active.stalls = 0;
    this.mouth(active, true);
    this.arm(active);
  }
  /** The pause did not hold: cancel; the rest is spoken again from the last word boundary (or this part's start). */
  private fallback(active: Active, reason: "still-speaking" | "resume-stuck"): void {
    this.yieldEngine(active);
    this.hooks.onEvent?.({ type: "pause-fallback", at: this.now(), reason });
  }
  /** Leave the engine (cancelling our utterance unless it already ended) and wait to continue from the last word. */
  private yieldEngine(active: Active, cancel = true): void {
    this.clearPauseTimer();
    active.offset = active.boundary ?? active.offset;
    active.engine = null; active.pause = "waiting"; active.respoken = true;
    this.mouth(active, false);
    if (cancel) this.cancelEngine();
  }
  private check(active: Active): void {
    this.watch = null;
    if (this.active !== active || !active.started || this.paused || active.pause !== "none") return;
    const at = this.now();
    const engine = this.engine();
    // The engine itself says nothing is playing while our utterance has not ended.
    if (engine && engine.speaking === false && engine.pending !== true) active.stalls++; else active.stalls = 0;
    if (active.stalls >= 2 && active.mouthOpen) { this.mouth(active, false); this.hooks.onEvent?.({ type: "stall", at, reason: "not-speaking" }); }
    else if (this.boundarySupported && active.mouthOpen && at - active.lastProgress > NO_PROGRESS_MS) {
      this.mouth(active, false); this.hooks.onEvent?.({ type: "stall", at, reason: "no-progress" });
    }
    this.arm(active);
  }
  private mouth(active: Active, open: boolean): void {
    if (active.mouthOpen === open) return;
    active.mouthOpen = open;
    this.hooks.onMouth?.(open);
  }
  private cancelEngine(): void {
    try { speechSynthesis.cancel(); } catch { /* The owned completion must still settle. */ }
    this.lastCancelAt = this.now();
    // A paused engine can stay paused after cancel() and silently hold the next utterance.
    try { if (this.engine()?.paused === true) speechSynthesis.resume(); } catch { /* Best effort. */ }
  }
  private engine(): { speaking?: boolean; pending?: boolean; paused?: boolean } | null {
    try { return typeof speechSynthesis === "undefined" ? null : speechSynthesis; } catch { return null; }
  }
  private get timers(): AudioOutputTimers { return this.hooks.timers ?? defaultAudioTimers; }
  private now(): number { return this.hooks.now?.() ?? performance.now(); }
  private arm(active: Active): void { if (this.watch === null) this.watch = this.timers.set(() => this.check(active), WATCH_MS); }
  private clearWatch(): void { if (this.watch !== null) { this.timers.clear(this.watch); this.watch = null; } }
  private clearDeferred(): void { if (this.deferred !== null) { this.timers.clear(this.deferred); this.deferred = null; } }
  private clearPauseTimer(): void { if (this.pauseTimer !== null) { this.timers.clear(this.pauseTimer); this.pauseTimer = null; } }
  private disarm(): void { this.clearWatch(); this.clearDeferred(); this.clearPauseTimer(); }
}
