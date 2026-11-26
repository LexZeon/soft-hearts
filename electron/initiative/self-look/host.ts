import { SEE_AND_SAY, withheldLook } from '../../../shared/senses';
import { SELF_LOOK_KNOBS, type SelfLookKnobs } from '../../../shared/behaviors/self-look/knobs';
import {
  SELF_LOOK_PROMPT, SELF_LOOK_SYSTEM_PROMPT, parseSelfLookResult, selfLookAsleep, selfLookEffects, selfLookHintLine, selfLookOpeningLine, wantToLook,
  type SelfLookMoment, type SelfLookTag, type SelfLookMoodInput, type SelfLookResult, type SelfLookSense, type SelfLookWant, type SelfLookWhy,
} from '../../../shared/initiative/self-look';

export interface SelfLookTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }

/** The camera as the user has it now: 「发图片」 on and free; on but held by a "别看"; off (or 「姿势识别」 only: no picture ever). */
export type SelfLookCamera = 'on' | 'held' | 'off';

/** One journal row (closed values only; never the line or anything seen). */
/** `hour` (I-168, only on a look that happened): how many looks of hers started in the last hour, this one included (no cap; the journal shows the count). */
export interface SelfLookRow { why: SelfLookWhy; sense: SelfLookSense; result: SelfLookResult; hour?: number }

export interface SelfLookPorts {
  /** The setting 「她自己看一眼」 (AppSettings.selfLook, default on). */
  enabled(): boolean;
  camera(): SelfLookCamera;
  /** The current character and conversation: the line belongs to exactly this pair. '' while there is none. */
  scope(): string;
  /** Her mood now (electron/mood/mood.ts MoodView), or null. */
  mood(): SelfLookMoodInput | null;
  /** The companion is shown, Claude is reachable: else she never looks (nothing is computed). */
  present(): boolean;
  /** The user is typing to her, just sent a message, or her reply is running. */
  typing(): boolean;
  /** When the user last talked to, touched or fed her (null: unknown). */
  lastInteractionAt(): number | null;
  /** Seconds since the last keyboard or mouse input (null: not read). */
  idleSeconds(): number | null;
  /** One camera frame now, as a data URL, memory only (null: none). Called only while camera() is 'on'. */
  capture(signal: AbortSignal): Promise<string | null>;
  /** haiku once: text and at most one picture (electron/senses/sense-router/model.ts senseAskWithClaude). */
  ask(prompt: string, systemPrompt: string, images: readonly string[], signal: AbortSignal): Promise<string>;
  /** The experience journal (it writes only while the user has the journal on). */
  journal?(row: SelfLookRow): void;
  /**
   * I-085 step 4a: she really looked (a frame was taken): the companion window lights its little eye mark for a moment. Nothing goes with it
   * (no line, no picture). Not called when the capture failed or the look was stopped.
   */
  eye?(): void;
  /**
   * I-085 step 4b: one mood moment from the look's closed tag (MoodHost.moments.note: its cooldown, daily count and the card's baseline
   * decide whether anything moves). Called only for a look that was not stopped, and only for tags with an effect.
   */
  moment?(kind: SelfLookMoment): void;
  /** I-089 item 5: the look's closed tag (present, smiling, tired, away, unclear; null: none), for the day's read of the user. Never the line, never the frame. */
  tag?(tag: SelfLookTag | null): void;
  /** Developer log: numbers and closed names only. */
  log?(entry: { want: number; why: SelfLookWhy | null; result: SelfLookResult | null }): void;
  knobs?: Partial<SelfLookKnobs>;
  clock?: () => number;
  timers?: SelfLookTimers;
}

/** `care`: the tag said tired or frowning (the next chat line leans caring, once: `careGiven`). */
interface Line { readonly text: string; readonly at: number; readonly scope: string; readonly care: boolean; careGiven: boolean }
interface Look { readonly controller: AbortController; readonly scope: string }

/**
 * I-085 第 1 步 on the host: about once a minute, whether she wants to take a look at the user (shared/initiative/self-look.ts, local); when she
 * does and the camera is on, one frame, haiku's one short line, kept in memory for her next chat turn (`hint`).
 *
 * Limits (each has a test that fails without it, tests/i085-self-look.test.ts):
 *  - only 「发图片」 (I-036) and never while a "别看" holds it (electron/senses/media-runtime.ts cameraHeld): 「姿势识别」 alone never gives chat a picture;
 *  - I-168: no cap on how often or when — no cooldown, no hourly count, no quiet window after typing. What she
 *    wants (wantToLook, once a minute: just looking lowers it, the user typing makes it 0) decides; one look at a time (no overlap). Worst
 *    case about 60 looks of her own an hour (one per minute tick), each one haiku call on the user's Claude usage; the journal row of
 *    every look carries how many started in the last hour (`hour`);
 *  - never while she is asleep, the companion is hidden or Claude is unreachable; the setting off: nothing at all;
 *  - the frame lives only inside one look; the line lives `lineTtlMs`, bound to one character and conversation, and is dropped on a
 *    "别看", the camera off, a switch, expiry, or the setting off; it reaches the chat model as text once, never the frame.
 */
export class SelfLookHost {
  private line: Line | null = null;
  private look: Look | null = null;
  /** The look under way, as a promise of how it ended (step 2 may wait for one that is already running). */
  private lookDone: Promise<SelfLookResult> | null = null;
  private lastLookAt: number | null = null;
  /** When the looks of the last hour started (the journal's count only; I-168: not a cap). */
  private readonly looks: number[] = [];
  private readonly lastRow = new Map<SelfLookResult, number>();
  private timer: unknown = null;
  private disposed = false;
  private readonly knobs: SelfLookKnobs;
  private readonly clock: () => number;
  private readonly timers: SelfLookTimers;
  /** Counts for tests and the developer panel. */
  readonly stats = { ticks: 0, wanted: 0, looks: 0, lines: 0, hints: 0, dropped: 0, failed: 0, moments: 0 };

  constructor(private readonly ports: SelfLookPorts) {
    this.knobs = { ...SELF_LOOK_KNOBS, ...ports.knobs };
    this.clock = ports.clock ?? Date.now;
    this.timers = ports.timers ?? {
      set: (callback, ms) => { const handle = setTimeout(callback, ms); (handle as { unref?: () => void }).unref?.(); return handle; },
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
  private enabled(): boolean { return !this.disposed && this.safe(() => this.ports.enabled() === true, false); }
  private camera(): SelfLookCamera { const value = this.safe(() => this.ports.camera(), 'off' as SelfLookCamera); return value === 'on' || value === 'held' ? value : 'off'; }
  private scope(): string { const value = this.safe(() => this.ports.scope(), ''); return typeof value === 'string' ? value : ''; }

  /** Starts the minute clock (main.ts, once). */
  start(): void {
    if (this.disposed || this.timer !== null) return;
    const loop = () => { this.timer = null; if (this.disposed) return; try { this.tick(); } catch { /* Never into the app. */ } this.timer = this.timers.set(loop, this.knobs.tickMs); };
    this.timer = this.timers.set(loop, this.knobs.tickMs);
  }

  /** The kept line, if it is still hers to use now (else it is dropped). */
  private freshLine(): Line | null {
    const line = this.line;
    if (!line) return null;
    const now = this.clock();
    if (!this.enabled() || this.camera() !== 'on' || line.scope !== this.scope() || now - line.at >= this.knobs.lineTtlMs || now < line.at) { this.drop(); return null; }
    return line;
  }

  /** One minute's decision. Public for tests (fake clock); the timer calls it. */
  tick(): void {
    this.stats.ticks++;
    if (!this.enabled()) { this.drop(); this.abortLook(); return; }
    this.freshLine();
    if (this.look) return;
    if (!this.safe(() => this.ports.present() === true, false)) return;
    const mood = this.safe(() => this.ports.mood(), null);
    if (!mood || selfLookAsleep(mood.fatigue)) return;
    const now = this.clock();
    const last = this.safe(() => this.ports.lastInteractionAt(), null);
    const idle = this.safe(() => this.ports.idleSeconds(), null);
    const want: SelfLookWant = wantToLook({
      mood, quietMs: typeof last === 'number' && Number.isFinite(last) ? Math.max(0, now - last) : null,
      idleSeconds: typeof idle === 'number' && Number.isFinite(idle) ? idle : null,
      typing: this.isTyping(now), sinceLastLookMs: this.lastLookAt === null ? null : Math.max(0, now - this.lastLookAt),
    }, this.knobs);
    if (!want.wants || !want.why) { this.logEntry(want, null); return; }
    this.stats.wanted++;
    const why = want.why;
    const camera = this.camera();
    if (camera === 'held') return this.skip(want, why, 'skipped-held');
    if (camera !== 'on') return this.skip(want, why, 'skipped-off');
    const started = this.begin(now);
    if (!started) return;
    void started.done.then(result => { this.row(why, result); this.logEntry(want, result); });
  }

  /** Runs one look (the same path for a look she wanted, the one before she speaks first and the one after a chat message). */
  private begin(now: number): { look: Look; done: Promise<SelfLookResult> } | null {
    const scope = this.scope();
    if (!scope) return null;
    this.lastLookAt = now;
    while (this.looks.length && (now - this.looks[0] >= 60 * 60_000 || now < this.looks[0])) this.looks.shift();
    this.looks.push(now);
    this.stats.looks++;
    const look: Look = { controller: new AbortController(), scope };
    this.look = look;
    const done: Promise<SelfLookResult> = this.run(look).then(result => {
      if (this.look === look) this.look = null;
      if (this.lookDone === done) this.lookDone = null;
      return result;
    });
    this.lookDone = done;
    return { look, done };
  }

  /**
   * I-085 step 2: she is about to speak first (electron/initiative/impulse/host.ts calls this once the floor and the dice have said "talk"). With
   * 「发图片」 on and free of a "别看", not asleep, the user not typing and inside step 1's caps, she takes one look first (the same path:
   * one frame, haiku's one line, memory only), waiting at most `openingWaitMs`, and the fresh line goes into her proactive line's context
   * (`openingLine`, read by electron/initiative/inner-loop/context.ts). A line she already has (10 minutes) is used as it is, no second look. If the
   * look cannot happen or fails or is late, she speaks without it. Nothing here delays the floor: the floor was checked before, and the
   * caller checks it again after. Resolves true when a fresh line is there to use.
   */
  async beforeSpeaking(): Promise<boolean> {
    try {
      if (!this.enabled()) return false;
      if (this.freshLine()) return true;
      if (this.lookDone) { await this.waitFor(this.lookDone, this.knobs.openingWaitMs); return this.freshLine() !== null; }
      if (!this.safe(() => this.ports.present() === true, false)) return false;
      const mood = this.safe(() => this.ports.mood(), null);
      if (mood && selfLookAsleep(mood.fatigue)) return false;
      const now = this.clock();
      if (this.isTyping(now)) return false;
      const camera = this.camera();
      // 「发图片」 off is her ordinary day (she just speaks): no row. A "别看" is worth one (at most one an hour).
      if (camera === 'held') { this.skip(null, 'opening', 'skipped-held'); return false; }
      if (camera !== 'on') return false;
      const started = this.begin(now);
      if (!started) return false;
      void started.done.then(result => { this.row('opening', result); this.logEntry(null, result); });
      await this.waitFor(started.done, this.knobs.openingWaitMs);
      return this.freshLine() !== null;
    } catch { return false; }
  }

  /**
   * I-085 第 5 节: the user just sent her a message. While they chat she seldom wants to look on her own, so
   * without this her turns mostly carry "最近也没看到用户". With the setting on, 「发图片」 on and free of a "别看", the companion shown, she
   * awake, no fresh line and no look under way, at least `cooldownMs` since her last look of any kind and under `chatPerHour`: one
   * look in the background (the same path: one frame, haiku's one line, memory only). This reply does not wait for it; the line is
   * there for her next turn (`hint`) and for a line she starts herself (`openingLine`).
   *
   * Not when this message says "别看" (or is not readable as one), or carries a clear camera picture (she sees for herself). The
   * user typing does not stop it: they are talking to her, which is the point; it is not her own want (`wantToLook`), so no
   * "she wanted to and did not" rows either: only a look that started writes a row (why `chat`). Returns whether a look started.
   */
  afterMessage(text: unknown, clearCamera: boolean): boolean {
    try {
      if (this.knobs.chatLook !== true || !this.enabled() || clearCamera) return false;
      if (this.saidNo(text)) return false;
      if (this.look || this.freshLine()) return false;
      if (this.camera() !== 'on') return false;
      if (!this.safe(() => this.ports.present() === true, false)) return false;
      const mood = this.safe(() => this.ports.mood(), null);
      if (mood && selfLookAsleep(mood.fatigue)) return false;
      const started = this.begin(this.clock());
      if (!started) return false;
      void started.done.then(result => { this.row('chat', result); this.logEntry(null, result, 'chat'); });
      return true;
    } catch { return false; }
  }

  private waitFor(promise: Promise<unknown>, ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      let handle: unknown = null, done = false;
      const finish = () => { if (done) return; done = true; if (handle !== null) this.timers.clear(handle); resolve(); };
      handle = this.timers.set(finish, Math.max(0, ms));
      if (done) this.timers.clear(handle);
      promise.then(finish, finish);
    });
  }

  /** Step 2: the fresh line as the proactive line's context ('' when there is none; it is not used up: the next chat turn may still have it). */
  openingLine(): string {
    try {
      const line = this.freshLine();
      return line ? selfLookOpeningLine(line.text, this.clock() - line.at, line.care) : '';
    } catch { return ''; }
  }

  /** The look itself: still allowed at every step (the user may say "别看", turn the camera off or switch meanwhile). */
  private async run(look: Look): Promise<SelfLookResult> {
    // The camera's own reason first (a "别看" or 「发图片」 off said meanwhile is what the journal shows), then anything else that ended it.
    const still = (): SelfLookResult | null => {
      const camera = this.camera();
      if (camera === 'held') return 'skipped-held';
      if (camera !== 'on') return 'skipped-off';
      return look.controller.signal.aborted || this.look !== look || !this.enabled() || this.scope() !== look.scope ? 'failed' : null;
    };
    let frame: string | null = null;
    try {
      frame = await this.within(look, signal => this.ports.capture(signal), this.knobs.captureTimeoutMs);
      const stop = still();
      if (stop) return stop;
      if (!frame) { this.stats.failed++; return 'failed'; }
      try { this.ports.eye?.(); } catch { /* The little eye is only a sign. */ }
      const raw =await this.within(look, signal => this.ports.ask(SELF_LOOK_PROMPT, SELF_LOOK_SYSTEM_PROMPT, [frame!], signal), this.knobs.askTimeoutMs);
      frame = null; // The picture is not kept past the call.
      const after = still();
      if (after) return after;
      const { text, tag } = parseSelfLookResult(raw, this.knobs);
      if (!text) { this.stats.failed++; return 'failed'; }
      const effects = selfLookEffects(tag);
      this.line = { text, at: this.clock(), scope: look.scope, care: effects.care, careGiven: false };
      this.stats.lines++;
      // Step 4b: the tag's small moments (MoodHost.moments has the caps); an unknown tag has none. Never A, never a dip.
      try { this.ports.tag?.(tag); } catch { /* The day's read just misses it. */ }
      for (const kind of effects.moments) { try { this.ports.moment?.(kind); this.stats.moments++; } catch { /* Her mood stays as it is. */ } }
      return 'looked';
    } catch { this.stats.failed++; return 'failed'; }
    finally { frame = null; }
  }

  private within<T>(look: Look, start: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | null> {
    return new Promise<T | null>(resolve => {
      let settled = false;
      const finish = (value: T | null) => { if (settled) return; settled = true; this.timers.clear(handle); look.controller.signal.removeEventListener('abort', onAbort); resolve(value); };
      const onAbort = () => finish(null);
      const handle = this.timers.set(() => { finish(null); }, Math.max(0, ms));
      look.controller.signal.addEventListener('abort', onAbort, { once: true });
      if (look.controller.signal.aborted) { finish(null); return; }
      try { start(look.controller.signal).then(value => finish(value), () => finish(null)); } catch { finish(null); }
    });
  }

  private skip(want: SelfLookWant | null, why: SelfLookWhy, result: SelfLookResult): void {
    // The same "she wanted to and did not" at most once per skipRowEveryMs: the journal shows when, not every minute of it.
    const now = this.clock(), last = this.lastRow.get(result);
    if (last === undefined || now - last >= this.knobs.skipRowEveryMs || now < last) { this.lastRow.set(result, now); this.row(why, result); }
    this.logEntry(want, result);
  }

  private row(why: SelfLookWhy, result: SelfLookResult): void {
    if (this.disposed) return;
    try { this.ports.journal?.({ why, sense: 'camera', result, ...(result === 'looked' ? { hour: this.looks.length } : {}) }); } catch { /* The journal never stops her. */ }
  }

  private logEntry(want: SelfLookWant | null, result: SelfLookResult | null, why: SelfLookWhy = 'opening'): void {
    try { this.ports.log?.({ want: want ? Math.round(want.score * 100) / 100 : 0, why: want ? want.why : why, result }); } catch { /* Best effort. */ }
  }

  /**
   * Her chat turn's private line (electron/main.ts, where the perception line goes): '' or "\n\n" + one line, given once and then
   * gone. Not given (and dropped) when this very message says "别看", or the turn already carries a clear camera picture she was
   * asked to take (she sees for herself). The small 「发图片」 picture does not replace it.
   *
   * `repeat` (I-085 第 3 步, text first): ordinary messages carry no camera picture any more, so the fresh line
   * goes with every message until it expires (`lineTtlMs`), each time with its age, instead of once.
   */
  hint(text: unknown, clearCamera: boolean, repeat = false): string {
    const line = this.freshLine();
    if (!line) return '';
    if (this.saidNo(text) || clearCamera) { this.drop(); return ''; }
    if (!repeat) this.line = null;
    this.stats.hints++;
    // The caring lean (tired or frowning) goes into one turn, not every turn while the line lives.
    const care = line.care && !line.careGiven;
    line.careGiven = true;
    return `\n\n${selfLookHintLine(line.text, this.clock() - line.at, care)}`;
  }

  /** Typing now (the app's own signal: typing, a message just sent, her reply running). Unknown counts as typing. I-168: no quiet window after it. */
  private isTyping(_now: number): boolean {
    return this.safe(() => this.ports.typing() === true, true);
  }

  /**
   * This message says no to looking (or cannot be read as not one). I-168 (SEE_AND_SAY.holdOnNo false): a "别看" changes nothing she does
   * with the camera; she hears it in the chat and decides herself. True only with holdOnNo on (the rule before).
   */
  private saidNo(text: unknown): boolean {
    if ((SEE_AND_SAY.holdOnNo as boolean) !== true) return false;
    const withheld = this.safe(() => withheldLook(String(text ?? '')), null);
    return withheld === 'refused' || withheld === 'unread';
  }

  /** The camera switches or a "别看" changed (main.ts mediaChanged): a line the camera no longer allows goes, and a look under way stops. */
  mediaChanged(): void {
    if (this.camera() === 'on') return;
    this.drop();
    this.abortLook();
  }

  /** A new conversation, another character, the vision context cleared: nothing seen belongs to the new one. */
  cancel(): void { this.drop(); this.abortLook(); }

  dispose(): void {
    this.cancel();
    this.disposed = true;
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
  }

  /** Tests and the developer panel: whether a line is kept (never its words). */
  get holding(): boolean { return this.line !== null; }
  get looking(): boolean { return this.look !== null; }

  private drop(): void { if (this.line) { this.line = null; this.stats.dropped++; } }
  private abortLook(): void { const look = this.look; if (look) { this.look = null; look.controller.abort(); } }
}
