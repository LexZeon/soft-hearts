/**
 * One warm, reused Web Audio output per window (R02; 2026-11-05 freeze).
 *
 * Creating an AudioContext and waiting for its output device to run is the only
 * unbounded step in the Bailian path, and it used to happen for every utterance
 * (and every reply segment) *before* the synthesis request was even sent, then
 * the context was closed again. This owner pays the device start once, keeps the
 * context while speech is active, suspends it only after a long idle period, and
 * measures how long each cold or suspended start took.
 *
 * The start itself is bounded (2026-11-04, she went mute after a start in a hidden
 * window): a start that has not run within AUDIO_OUTPUT_START_TIMEOUT_MS is given up and
 * whoever waited fails through the usual playback error path. A start still waiting when
 * the window becomes visible again is asked again at once, and one that was given up while
 * the window was hidden is retried once when it is shown.
 *
 * Codex T-207 round 6 (2026-11-04): the bound is one budget for the whole wait, counted from its first attempt; showing
 * the window retries inside it and never extends it (hidden, shown at 9 s, toggled again at 18 s used to wait 28 s). And
 * an idle suspend still in flight is never handed out as "running": a request that arrives meanwhile waits for it and
 * resumes the device (inside the same budget), so a late suspend cannot leave a reading silent and pending forever.
 *
 * 2026-11-05 (user: "现版本容易卡死", "点击试音也会卡一下"): on the user's machine `new AudioContext()` blocks the
 * window's main thread for a random 0.1–15 s (she stops moving), while `resume()` of an existing context is asynchronous
 * and does not stall frames even after minutes suspended. So the context is built at most once per window: early, at a
 * moment the window chooses (`warm()`), and kept for the window's life. Idle suspends it; every later start resumes the
 * same context. A start that is slow, fails, or is overtaken by the window being shown again asks the same context again
 * (within the same budget); it never closes it to build another. Building is not waiting for the device, so a build that
 * happens inside a start does not use up that start's budget (a 12 s build used to fail the start, close the context and
 * rebuild it on the next reading: a freeze every time). Only a context the browser closed or broke is replaced: a
 * `closed` state this owner did not cause, an `error` event, or AUDIO_OUTPUT_BROKEN_AFTER_FAILURES starts in a row that
 * used their whole budget with the window visible (resume measured ~0.1 s; a context that cannot start in 10 s twice is
 * wedged, and keeping it would leave her mute for the rest of the run). The replacement is built while nothing plays or
 * waits (the stall lands off the speaking moment), or by the next start when that start finds no usable context.
 */
import { uiText } from './ui-language';

export interface AudioOutputTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
/** Page visibility as this output needs it (the default reads `document`). */
export interface AudioOutputVisibility {
  hidden(): boolean;
  /** `listener` runs on every visibility change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}
export interface SharedAudioOutputOptions {
  createContext?(): AudioContext;
  now?(): number;
  /** Idle time before a warm context is suspended. 0 closes it as soon as it is idle (private per-player contexts only). */
  idleMs?: number;
  timers?: AudioOutputTimers;
  /** Longest wait for the device to run, from the first attempt, before this start is given up (retries included). */
  startTimeoutMs?: number;
  /** Omitted: `document` when there is one. null: no visibility handling. */
  visibility?: AudioOutputVisibility | null;
}
export interface AudioOutputLease {
  readonly context: AudioContext;
  /** Milliseconds this acquisition waited for the device (0 when already running). */
  readonly startMs: number;
  release(): void;
}

/**
 * 2026-11-06 (user: "刚刚的语音很慢"): on the user's machine a resume after the idle suspend took 4.3 s and 7.0 s in the
 * middle of a conversation (dev/speech-events: device start between replies 3–4 minutes apart), on top of synthesis. So a
 * conversation's ordinary pauses keep the device running; it is suspended only after 10 quiet minutes.
 */
export const AUDIO_OUTPUT_IDLE_MS = 600_000;
/**
 * Above the slowest device start this player is built to wait for (R02 measures and shows
 * starts of up to ~8 s), far below the 84 s a stuck start kept a reply silent (2026-11-04).
 * Building the context is not part of it (2026-11-05).
 */
export const AUDIO_OUTPUT_START_TIMEOUT_MS = 10_000;
/** Starts in a row that used their whole budget with the window visible before the context counts as broken. */
export const AUDIO_OUTPUT_BROKEN_AFTER_FAILURES = 2;
/** A resume() that was refused (not merely slow) is asked again after this long, within the same budget. */
export const AUDIO_OUTPUT_RETRY_MS = 500;
/** The User Timing measure each real context build leaves (name only, no content), for probes and the performance panel. */
export const AUDIO_CONTEXT_BUILD_MEASURE = 'soft-hearts:audio-context-build';
/** Housekeeping timers never keep a process alive on their own (browser timers are plain numbers). */
export const defaultAudioTimers: AudioOutputTimers = {
  set: (callback, ms) => { const handle = setTimeout(callback, ms); (handle as { unref?: () => void }).unref?.(); return handle; },
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const defaultTimers = defaultAudioTimers;

function documentVisibility(): AudioOutputVisibility | null {
  const doc = (globalThis as { document?: Partial<Document> }).document;
  if (!doc || typeof doc.addEventListener !== 'function' || typeof doc.removeEventListener !== 'function') return null;
  return {
    hidden: () => doc.visibilityState === 'hidden' || doc.hidden === true,
    subscribe: listener => {
      doc.addEventListener!('visibilitychange', listener);
      return () => doc.removeEventListener!('visibilitychange', listener);
    },
  };
}

function quietClose(context: AudioContext): void {
  try { if (context.state !== 'closed') void Promise.resolve(context.close()).catch(() => {}); } catch { /* Already gone. */ }
}

/** One device start as its waiters see it; it may take several attempts on the same context (window shown, refused resume). */
interface PendingStart {
  readonly promise: Promise<AudioContext>;
  resolve(context: AudioContext): void;
  reject(error: Error): void;
  readonly began: number;
  /** When this start is given up: the first attempt plus the budget, plus any time spent building a context. */
  deadline: number;
  context: AudioContext | null;
  attempt: number;
  timer: unknown;
  /** This start built a context already: it never builds a second one (a browser closing every new context cannot loop). */
  built: boolean;
  /** The window was hidden at some point while the current attempt waited. */
  hidden: boolean;
}

export class SharedAudioOutput {
  private context: AudioContext | null = null;
  /** The browser broke the current context (error event, or wedged): replace it before the next start. */
  private broken = false;
  /** Starts in a row on the current context that used their whole budget with the window visible. */
  private failedStarts = 0;
  private pending: PendingStart | null = null;
  private holders = 0;
  private idle: unknown = null;
  private replacing: unknown = null;
  private disposed = false;
  /** A start failed or was given up while the window was hidden: try once more when it is shown. */
  private retryOnVisible = false;
  private unwatch: (() => void) | null = null;
  /** The idle suspend asked of this context and not settled yet (the context still reads "running" meanwhile). */
  private suspending: { context: AudioContext; done: Promise<void> } | null = null;
  /** How long the most recent device start (create or resume) took, for diagnostics. */
  lastStartMs: number | undefined;
  /** Contexts this output has built (the stall the window shows), and how long the last build blocked. */
  builds = 0;
  lastBuildMs: number | undefined;

  constructor(private readonly options: SharedAudioOutputOptions = {}) {}

  private now(): number { return this.options.now?.() ?? performance.now(); }
  private get timers(): AudioOutputTimers { return this.options.timers ?? defaultTimers; }
  private get idleMs(): number { return this.options.idleMs ?? AUDIO_OUTPUT_IDLE_MS; }
  private get startTimeoutMs(): number { return this.options.startTimeoutMs ?? AUDIO_OUTPUT_START_TIMEOUT_MS; }
  private get visibility(): AudioOutputVisibility | null {
    return this.options.visibility === undefined ? documentVisibility() : this.options.visibility;
  }
  private hidden(): boolean { try { return this.visibility?.hidden() === true; } catch { return false; } }

  /**
   * Build this window's context now, if there is none, without waiting on it (2026-11-05). Building is the step that can
   * block the window for seconds, so the caller picks a moment where that shows least (while the model loads). Nothing
   * is resumed here; if the browser starts the new context, the usual idle period suspends it. Returns whether it built.
   */
  warm(): boolean {
    if (this.disposed || this.pending || this.usable()) return false;
    try { this.build(); } catch { return false; }
    // 2026-11-06 ("运行程序的第一句总是不会朗读"): a built context is not a running device. On the user's machine the first
    // resume() pays the cold device start (6.5 s measured), and when that was the first reading's resume she was silent for
    // that long and the user's next message cancelled her. Starting the device here, off the speaking moment, moves that
    // wait to init (resume is asynchronous: no frame stall). A start given up while hidden is retried when shown.
    this.prewarm();
    this.scheduleIdle();
    return true;
  }

  /**
   * Start the device early without holding it (chat send, preview click). Once it runs, the
   * usual idle period starts unless someone holds it by then, so a prewarm that no speech
   * follows (failed or cancelled reply, read-aloud off) does not keep the device running (X-088).
   */
  prewarm(): void { if (!this.disposed) void this.running().then(() => this.scheduleIdle(), () => {}); }

  /** Hold a running context. The caller must release it exactly once. */
  async acquire(): Promise<AudioOutputLease> {
    if (this.disposed) throw new Error(uiText('语音播放器已关闭。'));
    this.holders++;
    this.cancelIdle();
    const before = this.now();
    const wasRunning = !!this.usable() && this.context!.state === 'running' && !this.pending && !this.suspendingNow();
    let context: AudioContext;
    try { context = await this.running(); }
    catch (error) { this.holders--; this.scheduleIdle(); throw error; }
    let released = false;
    return {
      context,
      startMs: wasRunning ? 0 : Math.max(0, this.now() - before),
      release: () => {
        if (released) return;
        released = true;
        this.holders = Math.max(0, this.holders - 1);
        this.scheduleIdle();
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelIdle();
    this.close();
    this.retryOnVisible = false;
    this.watch();
  }

  /** The current context if a start may use it: not closed, not broken by the browser. */
  private usable(): AudioContext | null {
    const context = this.context;
    return context && !this.broken && context.state !== 'closed' ? context : null;
  }

  /** Build the window's context (the one step that blocks the window), replacing a closed or broken one. */
  private build(): AudioContext {
    this.cancelReplace();
    const before = this.now();
    const context = this.construct();
    this.lastBuildMs = Math.max(0, this.now() - before);
    this.builds++;
    const old = this.context;
    this.context = context; this.broken = false; this.failedStarts = 0;
    if (old && this.suspending?.context === old) this.suspending = null;
    if (old && old !== context) quietClose(old);
    this.follow(context);
    return context;
  }

  private construct(): AudioContext {
    if (this.options.createContext) return this.options.createContext();
    const start = performance.now();
    const context = new AudioContext({ latencyHint: 'interactive' });
    try { performance.measure(AUDIO_CONTEXT_BUILD_MEASURE, { start, end: performance.now() }); } catch { /* Diagnostics only. */ }
    return context;
  }

  /**
   * The browser closing or breaking this context (not this owner's own close) marks it for replacement: at once for a
   * start that is waiting on it (that reading needs a device either way), otherwise while nothing plays.
   */
  private follow(context: AudioContext): void {
    const target = context as Partial<EventTarget>;
    if (typeof target.addEventListener !== 'function') return;
    const broke = (event: Event) => {
      if (this.disposed || this.context !== context || this.broken) return;
      if (event.type === 'statechange' && context.state !== 'closed') return;
      this.broken = true;
      const pending = this.pending;
      if (pending && pending.context === context) this.attempt(pending);
      else this.replaceWhenIdle();
    };
    try { target.addEventListener('statechange', broke); target.addEventListener('error', broke); } catch { /* Best effort. */ }
  }

  private running(): Promise<AudioContext> {
    if (this.disposed) return Promise.reject(new Error(uiText('语音播放器已关闭。')));
    const pending = this.pending;
    if (pending) {
      // A start that waited through a hidden window is asked again once the window is visible.
      if (pending.hidden && !this.hidden()) this.restart(pending);
      return pending.promise;
    }
    const existing = this.usable();
    // A suspend in flight still reads "running": the request goes through a start that waits for it and resumes.
    if (existing && existing.state === 'running' && !this.suspendingNow()) return Promise.resolve(existing);
    let resolve!: (context: AudioContext) => void, reject!: (error: Error) => void;
    const promise = new Promise<AudioContext>((done, fail) => { resolve = done; reject = fail; });
    const began = this.now();
    const start: PendingStart = { promise, resolve, reject, began, deadline: began + this.startTimeoutMs, context: null, attempt: 0, timer: null, built: false, hidden: false };
    this.pending = start;
    this.attempt(start);
    this.watch();
    return promise;
  }

  /**
   * One attempt: resume this window's context and wait for it to run. Every attempt of one start shares its budget: a
   * retry gets what is left of it, never a new one. Only when there is no usable context (none built yet, or the browser
   * closed or broke it) is one built here, and that build time is added to the budget.
   */
  private attempt(pending: PendingStart): void {
    pending.hidden = this.hidden();
    if (pending.timer !== null) { this.timers.clear(pending.timer); pending.timer = null; }
    let context = this.usable();
    if (!context) {
      if (pending.built) { this.settle(pending, new Error(uiText('音频输出未就绪，请点击试听后重试。'))); return; }
      pending.built = true;
      const before = this.now();
      try { context = this.build(); } catch (error) { this.settle(pending, error); return; }
      pending.deadline += Math.max(0, this.now() - before);
    }
    const attempt = ++pending.attempt;
    const current = () => this.pending === pending && pending.attempt === attempt;
    pending.context = context;
    const suspending = this.suspendingNow(context);
    const target = context;
    pending.timer = this.timers.set(() => {
      pending.timer = null;
      if (current()) this.settle(pending, new Error(uiText('音频输出未就绪，请点击试听后重试。')));
    }, Math.max(0, pending.deadline - this.now()));
    void (async () => {
      // A late idle suspend lands first; the resume below then runs the device again.
      if (suspending) await suspending;
      if (target.state !== 'running') await target.resume();
      if (target.state !== 'running') throw new Error(uiText('音频输出未就绪，请点击试听后重试。'));
    })().then(() => { if (current()) this.settle(pending, null); }, error => { if (current()) this.refused(pending, error); });
  }

  /** resume() was refused: ask the same context again shortly (a closed one is replaced at once), inside the budget. */
  private refused(pending: PendingStart, error: unknown): void {
    if (!this.usable()) { this.attempt(pending); return; }
    if (pending.deadline - this.now() <= AUDIO_OUTPUT_RETRY_MS) { this.settle(pending, error); return; }
    if (pending.timer !== null) { this.timers.clear(pending.timer); pending.timer = null; }
    const attempt = pending.attempt;
    pending.timer = this.timers.set(() => {
      pending.timer = null;
      if (this.pending === pending && pending.attempt === attempt) this.attempt(pending);
    }, AUDIO_OUTPUT_RETRY_MS);
  }

  /** The window is visible again while a start still waits: ask the same context again for the same waiters. */
  private restart(pending: PendingStart): void { this.attempt(pending); }

  private settle(pending: PendingStart, failure: unknown): void {
    if (this.pending !== pending) return;
    if (pending.timer !== null) { this.timers.clear(pending.timer); pending.timer = null; }
    this.pending = null;
    const context = pending.context;
    if (failure === null && context) {
      this.retryOnVisible = false;
      if (context === this.context) this.failedStarts = 0;
      this.lastStartMs = Math.max(0, this.now() - pending.began);
      this.watch();
      pending.resolve(context);
      return;
    }
    // A failed start keeps its context: the next request resumes the same one (building another is what froze her).
    // Only a context that could not start, again and again, with the window visible counts as broken by the browser.
    const hidden = pending.hidden || this.hidden();
    if (context && context === this.context && !hidden && ++this.failedStarts >= AUDIO_OUTPUT_BROKEN_AFTER_FAILURES) this.broken = true;
    this.retryOnVisible = !this.disposed && hidden;
    this.watch();
    pending.reject(failure instanceof Error ? failure : new Error(String(failure)));
    this.replaceWhenIdle();
  }

  /**
   * A closed or broken context is rebuilt while nothing holds or waits for the output, in a task of its own, so the
   * stall does not land on a reading; while a reading holds it, this waits for the release.
   */
  private replaceWhenIdle(): void {
    const context = this.context;
    if (this.disposed || !context || (!this.broken && context.state !== 'closed') || this.holders > 0 || this.pending || this.replacing !== null) return;
    this.replacing = this.timers.set(() => {
      this.replacing = null;
      const current = this.context;
      if (this.disposed || !current || (!this.broken && current.state !== 'closed') || this.holders > 0 || this.pending) return;
      try { this.build(); } catch { return; }
      this.scheduleIdle();
    }, 0);
  }

  private cancelReplace(): void {
    if (this.replacing !== null) { this.timers.clear(this.replacing); this.replacing = null; }
  }

  /** Listen for visibility only while a start waits or a hidden failure awaits its retry (no listener otherwise). */
  private watch(): void {
    const wanted = !this.disposed && (this.pending !== null || this.retryOnVisible);
    if (wanted && !this.unwatch) {
      try { this.unwatch = this.visibility?.subscribe(() => this.visibilityChanged()) ?? null; } catch { this.unwatch = null; }
    } else if (!wanted && this.unwatch) {
      const unwatch = this.unwatch; this.unwatch = null;
      try { unwatch(); } catch { /* Best effort. */ }
    }
  }

  private visibilityChanged(): void {
    if (this.disposed) return;
    const pending = this.pending;
    if (this.hidden()) { if (pending) pending.hidden = true; return; }
    if (pending) { if (pending.hidden) this.restart(pending); return; }
    if (this.retryOnVisible) { this.retryOnVisible = false; this.watch(); this.prewarm(); }
  }

  private scheduleIdle(): void {
    if (this.disposed || this.holders > 0) return;
    this.cancelIdle();
    if (this.idleMs <= 0) { this.close(); return; }
    this.replaceWhenIdle();
    this.idle = this.timers.set(() => {
      this.idle = null;
      const context = this.context;
      if (this.holders > 0 || !context || this.pending || this.suspendingNow(context)) return;
      if (context.state !== 'running' || typeof context.suspend !== 'function') return;
      let done: Promise<void>;
      try { done = Promise.resolve(context.suspend()).catch(() => {}); } catch { return; }
      const suspending = { context, done: done.then(() => { if (this.suspending === suspending) this.suspending = null; }) };
      this.suspending = suspending;
    }, this.idleMs);
  }

  /** The suspend in flight on `context` (the current one when omitted), if any. */
  private suspendingNow(context = this.context): Promise<void> | null {
    const suspending = this.suspending;
    return suspending && context && suspending.context === context ? suspending.done : null;
  }

  private cancelIdle(): void {
    if (this.idle !== null) { this.timers.clear(this.idle); this.idle = null; }
  }

  /** dispose(), or a private context (idleMs 0) that is idle: the only places this owner closes a context. */
  private close(): void {
    const context = this.context, pending = this.pending;
    this.context = null;
    this.pending = null;
    this.suspending = null;
    this.broken = false;
    this.failedStarts = 0;
    this.retryOnVisible = false;
    this.cancelReplace();
    if (pending) {
      if (pending.timer !== null) { this.timers.clear(pending.timer); pending.timer = null; }
      pending.reject(new Error(uiText('语音播放器已关闭。')));
    }
    if (context) quietClose(context);
    this.watch();
  }
}
