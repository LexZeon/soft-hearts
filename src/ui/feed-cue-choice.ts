/**
 * #32 (shared/behaviors/feed-cue/), pet window: the B06 cue port that plays the sound she picked for this snack. FeedSpeechPause
 * still owns the timing (a "啊" moment at her mouth, a "嗯" moment at the bite); this only answers "which sound, if any":
 *
 *   the host picked for this snack (MoodView.feedCue, published with the view of the snack's first 'food-wait', and again
 *   with the bite's) ─▶ at the mouth: open.sound; at the bite: eat.sound; null = she makes no sound this time.
 *
 * - The pick normally arrives before the moment. If it has not (a very fast drag; the bite's pick comes a few ms after the
 *   bite), the moment waits a little (FEED_CUE_PLAN_WAIT_MS, inside its own deadline), then plays the original sound.
 *   While 自动表现 is off the host picks nothing: the original "啊～""嗯～" at once, as before.
 * - A sound not synthesized yet in this Bailian voice: the original sound if its clip is here, otherwise only the motion;
 *   the picked one is fetched first, for next time. Never a different voice, never late, never blocking the feed.
 * - The same snack back at her mouth again says what she picked for it again (no new pick, no wait).
 * - Each snack's sounds are its own (Codex T-209): told which snack is being fed (feeding(sessionId), from FeedSpeechPause), a moment
 *   uses only the pick carrying that snack's session, never one an earlier snack left unheard. A moment still waiting for its pick is
 *   dropped when its snack is gone (dragged away, cancelled) or the host's character changes: a late pick never makes her speak for a
 *   snack that is gone, nor for the other character. Without a session (a caller that does not say), the last pick, as before.
 * It reads only names and numbers from the view (readFeedCueView), never text: the text is the host's, per sound.
 */
import { readFeedCueView } from '../../shared/behaviors/feed-cue/perform';
import type { FeedCueView } from '../../shared/behaviors/feed-cue/interface';
import type { CueKind, FeedCueKind } from '../../shared/feed-cue';
import { defaultAudioTimers, type AudioOutputTimers } from './audio-output';
import type { FeedCuePort, FeedCueStarted } from './feed-speech-pause';

/** The cue player underneath (FeedCuePlayer). */
export interface ChosenFeedCuePlayer {
  play(kind: CueKind, deadlineMs: number): Promise<FeedCueStarted | null>;
  stop(): void;
  /** Fetch clips (feeding started); `first` is fetched before the others. */
  prepare?(first?: CueKind): void;
  sharesEngine?(): boolean;
  /** The clip can start now (absent: assume it can, e.g. a test port). */
  ready?(kind: CueKind): boolean;
}
/** The part of a MoodView this reads. */
export interface ChosenFeedCueViewInput { characterId?: unknown; expressions?: unknown; feedCue?: unknown }
export interface ChosenFeedCuesOptions {
  player: ChosenFeedCuePlayer;
  /** The host's mood views (window.desktop.onMood). */
  onMood?(listener: (view: ChosenFeedCueViewInput) => void): (() => void) | void;
  timers?: AudioOutputTimers;
  now?(): number;
}
/** How long a moment may wait for the host's pick of this snack (inside the moment's own deadline). */
export const FEED_CUE_PLAN_WAIT_MS: Readonly<Record<FeedCueKind, number>> = Object.freeze({ ah: 120, mm: 180 });
/** Leave at least this much of the deadline for the sound itself to start. */
const START_MARGIN_MS = 100;

export type ChosenFeedCueSource = 'plan' | 'original' | 'cached-original' | 'quiet' | 'not-ready';

export class ChosenFeedCues implements FeedCuePort {
  private plan: FeedCueView | null = null;
  private expressions = true;
  private characterId = '';
  /** Plan ids already used for each moment (newest first). */
  private readonly used: Record<FeedCueKind, string[]> = { ah: [], mm: [] };
  /** The open pick used for the snack being fed now ('' once a new snack starts). */
  private snackOpen = '';
  /** The snack being fed (its interaction session), null when unknown or none; `snack` counts every change. */
  private session: string | null = null;
  private snack = 0;
  private readonly waiters = new Set<() => void>();
  private token = 0;
  private readonly unsubscribe: (() => void) | null;
  private disposed = false;
  /** What the last moment did (tests and developer checks): which sound, and where it came from. */
  last: { moment: FeedCueKind; sound: CueKind | null; source: ChosenFeedCueSource } | null = null;

  constructor(private readonly options: ChosenFeedCuesOptions) {
    let off: (() => void) | null = null;
    try { off = options.onMood?.(view => this.view(view)) ?? null; } catch { off = null; }
    this.unsubscribe = typeof off === 'function' ? off : null;
  }

  /** A mood view from the host (also callable directly). */
  view(view: ChosenFeedCueViewInput | null | undefined): void {
    if (this.disposed || !view || typeof view !== 'object') return;
    const characterId = typeof view.characterId === 'string' ? view.characterId : '';
    if (characterId !== this.characterId) {
      // Another character's view: a moment still waiting belonged to the one before and is dropped (woken below).
      if (this.characterId) this.token++;
      this.characterId = characterId; this.plan = null; this.used.ah = []; this.used.mm = []; this.snackOpen = '';
    }
    this.expressions = view.expressions !== false;
    const plan = view.feedCue === undefined ? null : readFeedCueView(view.feedCue);
    // A view without a pick keeps the last one (an unrelated publish between the bite and its pick changes nothing).
    if (plan) this.plan = plan;
    else if (!this.expressions) this.plan = null;
    for (const wake of [...this.waiters]) wake();
  }

  prepare(): void {
    this.snackOpen = ''; // a new snack: its own pick
    try { this.options.player.prepare?.(); } catch { /* A cue is optional. */ }
  }
  /** The snack being fed changed (FeedCuePort.feeding): its session, undefined when it has none, null once it is gone. */
  feeding(sessionId: string | null | undefined): void {
    if (this.disposed) return;
    const session = typeof sessionId === 'string' && sessionId ? sessionId : null;
    this.snack++; this.session = session;
    if (sessionId !== null) this.snackOpen = '';
    for (const wake of [...this.waiters]) wake();
  }
  sharesEngine(): boolean { try { return this.options.player.sharesEngine?.() === true; } catch { return false; } }
  stop(): void {
    this.token++;
    for (const wake of [...this.waiters]) wake();
    try { this.options.player.stop(); } catch { /* Best effort. */ }
  }
  dispose(): void { if (this.disposed) return; this.stop(); this.disposed = true; try { this.unsubscribe?.(); } catch { /* Already gone. */ } }

  async play(moment: FeedCueKind, deadlineMs: number): Promise<FeedCueStarted | null> {
    const token = ++this.token, startedAt = this.now(), snack = this.snack, session = this.session;
    if (this.disposed) return null;
    let plan = this.pick(moment, session);
    if (!plan && this.expressions) plan = await this.waitFor(moment, Math.min(FEED_CUE_PLAN_WAIT_MS[moment], Math.max(0, deadlineMs - START_MARGIN_MS)), token, snack, session);
    if (token !== this.token || snack !== this.snack || this.disposed) return null;
    const left = deadlineMs - (this.now() - startedAt);
    if (left <= 0) return null;
    let sound: CueKind | null = moment, source: ChosenFeedCueSource = 'original';
    if (plan) {
      if (moment === 'ah') { this.note('ah', plan.open.id); this.snackOpen = plan.open.id; sound = plan.open.sound; }
      else if (plan.eat) { this.note('mm', plan.eat.id); sound = plan.eat.sound; }
      source = 'plan';
      if (sound === null) { this.last = { moment, sound: null, source: 'quiet' }; return null; }
    }
    const player = this.options.player;
    let ready = true;
    try { ready = player.ready ? player.ready(sound) : true; } catch { ready = false; }
    if (!ready) {
      // Not synthesized yet in this voice: fetched first for next time; now the original sound if it is here, else only the motion.
      try { player.prepare?.(sound); } catch { /* A cue is optional. */ }
      let original = false;
      try { original = sound !== moment && !!player.ready?.(moment); } catch { original = false; }
      if (!original) { this.last = { moment, sound: null, source: 'not-ready' }; return null; }
      sound = moment; source = 'cached-original';
    }
    this.last = { moment, sound, source };
    try { return await player.play(sound, left); } catch { return null; }
  }

  /**
   * The pick this moment may use now: a new one for this snack, or (back at her mouth) the one this snack already has. With the
   * snack's session known, only a pick for that session (another snack's, even one never heard, is not this one's).
   */
  private pick(moment: FeedCueKind, session: string | null): FeedCueView | null {
    const plan = this.plan;
    if (!plan || (session !== null && plan.sessionId !== session)) return null;
    if (moment === 'ah') return !this.used.ah.includes(plan.open.id) || (this.snackOpen !== '' && plan.open.id === this.snackOpen) ? plan : null;
    return plan.eat && !this.used.mm.includes(plan.eat.id) ? plan : null;
  }

  private note(moment: FeedCueKind, id: string): void {
    const list = this.used[moment];
    if (!list.includes(id)) { list.unshift(id); list.splice(8); }
  }

  private waitFor(moment: FeedCueKind, ms: number, token: number, snack: number, session: string | null): Promise<FeedCueView | null> {
    if (ms <= 0) return Promise.resolve(null);
    return new Promise(resolve => {
      let done = false;
      const finish = (plan: FeedCueView | null) => {
        if (done) return; done = true;
        this.waiters.delete(check); this.timers.clear(timer); resolve(plan);
      };
      const check = () => {
        // Stopped, another snack (or none: it was dragged away), another character: this moment is over.
        if (token !== this.token || snack !== this.snack || this.disposed) { finish(null); return; }
        const plan = this.pick(moment, session);
        if (plan) finish(plan);
        else if (!this.expressions) finish(null);
      };
      const timer = this.timers.set(() => finish(null), ms);
      this.waiters.add(check);
    });
  }

  private get timers(): AudioOutputTimers { return this.options.timers ?? defaultAudioTimers; }
  private now(): number { return this.options.now?.() ?? performance.now(); }
}
