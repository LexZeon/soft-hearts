import { parseGlanceAnswer, programActivity, programKey, type ScreenActivity } from '../shared/screen-activity';
import type { ForegroundProbe, ForegroundReading } from './foreground-app';
import { BrowserVideoGate } from '../shared/behaviors/watch-along/gate';
import { WATCH_ALONG_KNOBS } from '../shared/behaviors/watch-along/knobs';

/**
 * 屏幕只读大概 · 扫一眼 (I-015).
 *
 * With screen sharing on, an ordinary message carries no picture: her turn says only roughly what the user is doing ("用户大概在写
 * 代码"), or that she does not know. This host keeps that rough picture, in memory only, and only while sharing is on:
 *  - the program in front, read by a small helper started with sharing and stopped with it (electron/foreground-app.ts), mapped at
 *    once to an activity (shared/screen-activity.ts). Its name stays in this object, keyed for the cache below; it is never saved,
 *    logged, shown or sent, and no window title, address or file name is ever read.
 *  - this app's own windows (the user typing to her) do not count: what was in front before them still does, for LAST_SEEN_MS.
 *  - a program the table cannot tell (browsers first of all): when the user is about to talk to her (typing), and the program was
 *    in front a moment ago, one 320×200 thumbnail is taken in the background and the small model answers one word. The answer is
 *    kept per program for GLANCE_CACHE_MS; the picture is dropped as soon as the model has it, and nothing waits for any of this.
 *  - unreadable, stale, failed, a model that is unavailable or answers anything but one word: "不知道" (null), never a guess.
 *  - I-006 step 3 (docs/claude/2026-11-06-i006-step3.md): a browser that has been in front for a minute while the user has not touched the
 *    keyboard or mouse for a while looks like a video being watched: `watchTick()` (the existing one-second beat) may then ask for one
 *    such look, at most once while the browser stays in front and the user stays away, within an hourly count that grows with chat
 *    and interaction (shared/behaviors/watch-along/gate.ts, memory only). `watching()` is what her own life follows.
 *  - sharing off: the helper stops, and everything here is forgotten at once; a late answer from before is dropped.
 *
 * `rough()` is synchronous and reads memory only, so the send path never waits for it (the first token does not move).
 */

/** A look's answer for one program counts this long (the page in a browser changes). */
export const GLANCE_CACHE_MS = 5 * 60_000;
/** After a failed or unanswered look, the same program is not looked at again for this long. */
export const GLANCE_RETRY_MS = 2 * 60_000;
/** Two looks of any program are at least this far apart. */
export const GLANCE_GAP_MS = 30_000;
/** A look (thumbnail and the small model) that takes longer is dropped. */
export const GLANCE_TIMEOUT_MS = 30_000;
/** No line from the helper for this long: it is not reading, so "不知道". */
export const PROBE_STALE_MS = 15_000;
/** The program last in front (before her own window) counts this long; after that "不知道". */
export const LAST_SEEN_MS = 5 * 60_000;
/** A look is taken only for a program that was in front within this long (the screen still shows it). */
export const GLANCE_RECENT_MS = 60_000;
/** The helper is started again at most this many times in one opening of sharing when it ends by itself. */
export const PROBE_RESTARTS = 3;
/** Programs whose look is remembered, at most (names in memory only). */
const LOOKS_KEPT = 32;

export interface ScreenGlancePorts {
  /** The foreground reader; null where there is none (not Windows): then "不知道". */
  probe: ForegroundProbe | null;
  /** One thumbnail of the shared screen, 320×200 at most, as a JPEG data URL; null when it cannot be taken. */
  thumbnail(signal: AbortSignal): Promise<string | null>;
  /** The small model's answer for a thumbnail (electron/inner-loop/model.ts quickLineWithClaude with the picture). */
  classify(dataUrl: string, signal: AbortSignal): Promise<string>;
  /** A look is allowed now: sharing on, the pet visible, the user has not said no, the chat model available. */
  mayLook(): boolean;
  /** I-006 step 3: seconds since the user last touched the keyboard or mouse; null when not known (the 「知道你是不是在忙」 switch is off, locked, unreadable). */
  idleSeconds?(): number | null;
  /** I-006 step 3: chats and interactions in the past hour (the interaction budget's count), for the hourly look count. */
  interactionsLastHour?(): number;
  clock?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** What the developer panel and tests may see: never a program name. */
export interface ScreenGlanceView { sharing: boolean; activity: ScreenActivity | null; reading: boolean; looks: number; answered: number }

interface InFront { key: string | null; activity: ScreenActivity | 'look' | null; at: number }

export class ScreenGlance {
  private on = false;
  private opening = 0;
  private heartbeat = -Infinity;
  private last: InFront | null = null;
  private readonly looks = new Map<string, { activity: ScreenActivity | null; at: number }>();
  private looking: { controller: AbortController; opening: number } | null = null;
  private lastLookAt = -Infinity;
  private restarts = 0;
  private restartTimer: unknown = null;
  private lookCount = 0;
  private answerCount = 0;
  private disposed = false;
  private readonly gate = new BrowserVideoGate();
  /** The answer of a look the gate asked for: kept while the same browser stays in front and the user stays away from the keyboard. */
  private streak: { key: string; activity: ScreenActivity } | null = null;
  private readonly clock: () => number;
  private readonly later: (callback: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(private readonly ports: ScreenGlancePorts) {
    this.clock = ports.clock ?? Date.now;
    this.later = ports.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.cancel = ports.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Screen sharing turned on or off (electron/main.ts mediaChanged). Off: nothing is read any more and everything is forgotten. */
  setSharing(on: boolean): void {
    if (this.disposed || on === this.on) return;
    this.on = on;
    this.opening++;
    this.forget();
    if (on) this.startProbe();
    else this.ports.probe?.stop();
  }

  /** The rough activity for this turn, from memory only; null: "不知道". */
  rough(): ScreenActivity | null {
    const last = this.last;
    if (!this.on || !last || last.key === null || last.activity === null) return null;
    const now = this.clock();
    if (now < last.at || now - this.heartbeat > PROBE_STALE_MS || now - last.at > LAST_SEEN_MS) return null;
    if (last.activity !== 'look') return last.activity;
    const seen = this.looks.get(last.key);
    return seen && now >= seen.at && now - seen.at <= GLANCE_CACHE_MS ? seen.activity : null;
  }

  /**
   * What her own life follows (I-006 step 3): the rough activity, but an answer the gate asked for stays as long as that browser stays in
   * front and the user stays away (a 40-minute episode is not forgotten after the 5-minute cache). Sharing off: always null.
   */
  watching(): ScreenActivity | null {
    const streak = this.streak, last = this.last, now = this.clock();
    if (this.on && streak && last && last.key === streak.key && now >= last.at && now - this.heartbeat <= PROBE_STALE_MS && now - last.at <= LAST_SEEN_MS) return streak.activity;
    return this.rough();
  }

  /**
   * The existing one-second beat (electron/main.ts). A browser in front for a minute and the user away from the keyboard: one look, if the
   * gate allows it. Never when sharing is off, the user said no, the chat model is unavailable, or the idle seconds are not known.
   */
  watchTick(): void {
    if (this.disposed || !this.on) return;
    const last = this.last, now = this.clock();
    const front = last && last.key !== null && last.activity === 'look' && now >= last.at && now - this.heartbeat <= PROBE_STALE_MS ? last.key : null;
    this.gate.front(front, now);
    const idle = this.safely(() => this.ports.idleSeconds?.() ?? null, null);
    if (idle !== null && idle < WATCH_ALONG_KNOBS.idleSeconds) {
      // The user is back at the keyboard: the answer of a look no longer holds, and the gate hears that the pause is over.
      this.streak = null;
      this.gate.ask({ now, idleSeconds: idle, interactionsLastHour: 0 });
      return;
    }
    if (front === null || this.looking || now - this.lastLookAt < GLANCE_GAP_MS || idle === null) return;
    if (!this.safely(() => this.ports.mayLook(), false)) return;
    if (!this.gate.ask({ now, idleSeconds: idle, interactionsLastHour: this.safely(() => this.ports.interactionsLastHour?.() ?? 0, 0) })) return;
    this.lastLookAt = now;
    void this.look(front, true);
  }

  /**
   * The user is about to talk to her (typing; electron/main.ts noteChatTyping). When the program in front a moment ago is one only a
   * look can tell and no fresh answer is kept, one look starts in the background. Never more than one at a time, GLANCE_GAP_MS apart.
   */
  noteTalk(): void {
    if (this.disposed || !this.on || this.looking) return;
    const last = this.last, now = this.clock();
    if (!last || last.key === null || last.activity !== 'look' || now < last.at || now - last.at > GLANCE_RECENT_MS
      || now - this.heartbeat > PROBE_STALE_MS || now - this.lastLookAt < GLANCE_GAP_MS) return;
    const seen = this.looks.get(last.key);
    if (seen && now >= seen.at && now - seen.at < (seen.activity ? GLANCE_CACHE_MS : GLANCE_RETRY_MS)) return;
    if (!this.safely(() => this.ports.mayLook(), false)) return;
    this.lastLookAt = now;
    void this.look(last.key);
  }

  /** Counts and the activity only (developer panel, tests). */
  view(): ScreenGlanceView {
    return { sharing: this.on, activity: this.rough(), reading: this.on && this.clock() - this.heartbeat <= PROBE_STALE_MS,
      looks: this.lookCount, answered: this.answerCount };
  }

  dispose(): void {
    if (this.disposed) return;
    this.setSharing(false);
    this.disposed = true;
  }

  private forget(): void {
    this.last = null;
    this.heartbeat = -Infinity;
    this.looks.clear();
    this.looking?.controller.abort();
    this.looking = null;
    this.lastLookAt = -Infinity;
    this.gate.reset();
    this.streak = null;
    this.restarts = 0;
    if (this.restartTimer !== null) { this.cancel(this.restartTimer); this.restartTimer = null; }
  }

  private startProbe(): void {
    const probe = this.ports.probe, opening = this.opening;
    if (!probe) return;
    try { probe.start(value => this.read(opening, value), () => this.ended(opening)); }
    catch { this.ended(opening); }
  }

  private read(opening: number, value: ForegroundReading): void {
    if (opening !== this.opening || !this.on) return;
    const now = this.clock();
    this.heartbeat = now;
    if (value === 'self') { this.gate.front(null, now); this.streak = null; return; } // her own window: what was in front before still counts (but not as a browser left in front)
    const key = value === null ? null : programKey(value.exe);
    this.last = { key, activity: key === null || value === null ? null : programActivity(value.exe), at: now };
  }

  private ended(opening: number): void {
    if (opening !== this.opening || !this.on || this.disposed) return;
    this.heartbeat = -Infinity;
    if (this.restarts >= PROBE_RESTARTS || this.restartTimer !== null) return;
    this.restarts++;
    this.restartTimer = this.later(() => {
      this.restartTimer = null;
      if (opening === this.opening && this.on && !this.disposed) this.startProbe();
    }, 5_000 * this.restarts);
  }

  private async look(key: string, forWatch = false): Promise<void> {
    const controller = new AbortController(), opening = this.opening;
    this.looking = { controller, opening };
    this.lookCount++;
    let timedOut = false;
    const timer = this.later(() => { timedOut = true; controller.abort(); }, GLANCE_TIMEOUT_MS);
    let activity: ScreenActivity | null = null;
    try {
      let picture = await settleBy(this.ports.thumbnail(controller.signal), controller.signal);
      if (picture && opening === this.opening && this.on && this.safely(() => this.ports.mayLook(), false)) {
        const answer = this.ports.classify(picture, controller.signal);
        picture = null; // the model call has it; nothing here keeps the picture
        activity = parseGlanceAnswer(await settleBy(answer, controller.signal));
      }
    } catch { activity = null; }
    finally {
      this.cancel(timer);
      if (this.looking?.controller === controller) this.looking = null;
    }
    // Sharing went off (or off and on) meanwhile: the answer belongs to nothing any more.
    if (opening !== this.opening || !this.on || (controller.signal.aborted && !timedOut)) return;
    if (activity) this.answerCount++;
    this.looks.delete(key);
    this.looks.set(key, { activity, at: this.clock() });
    if (forWatch && activity) this.streak = { key, activity };
    while (this.looks.size > LOOKS_KEPT) this.looks.delete(this.looks.keys().next().value!);
  }

  private safely<T>(read: () => T, fallback: T): T {
    try { return read(); } catch { return fallback; }
  }
}

/** `work`, or a rejection as soon as `signal` aborts (a port that ignores the signal cannot hold a look open). */
function settleBy<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
